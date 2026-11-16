import { createSign } from "node:crypto";
import {
  looksLikeGoogleCredentialPath,
  readGoogleCredentialFile,
  vertexCredentialFile,
} from "./vertex-credentials.js";

export { resolveGoogleCredentialPath, wellKnownGoogleAdcPath } from "./vertex-credentials.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKEN_TIMEOUT_MS = 30_000;

function requiredString(data: Record<string, unknown>, name: string): string {
  const value = data[name];
  if (typeof value !== "string" || !value) {
    throw new Error(`Invalid Google ADC credentials: ${name} must be a non-empty string`);
  }
  return value;
}

/** Form grants without retaining credential material in errors or cache keys. */
function tokenGrant(data: Record<string, unknown>, now: number): URLSearchParams {
  if (data.type === "authorized_user") {
    return new URLSearchParams({
      grant_type: "refresh_token",
      client_id: requiredString(data, "client_id"),
      client_secret: requiredString(data, "client_secret"),
      refresh_token: requiredString(data, "refresh_token"),
    });
  }
  if (data.type !== "service_account") {
    // Only a short type identifier is safe to name, never stringify arbitrary JSON.
    const type = typeof data.type === "string" && /^[a-z_]{1,64}$/.test(data.type) ? `: ${data.type}` : "";
    throw new Error(`Unsupported Google ADC credential type${type}`);
  }
  const email = requiredString(data, "client_email");
  const key = requiredString(data, "private_key");
  const issuedAt = Math.floor(now / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: TOKEN_ENDPOINT,
    iat: issuedAt,
    exp: issuedAt + 3600,
  })}`;
  let signature: string;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signature = signer.sign(key).toString("base64url");
  } catch {
    throw new Error("Invalid Google ADC service-account signing key");
  }
  return new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${unsigned}.${signature}`,
  });
}

/** Process-local cache. Dependencies are late-bound so callers can inject fetch/clock. */
export function createTokenResolver(deps: { fetch: typeof fetch; now: () => number; timeoutMs?: number }) {
  const tokens = new Map<string, Promise<string>>();
  const expiresAt = new Map<string, number>();
  return function tokenForFile(file: string): Promise<string> {
    const { data, cacheKey } = readGoogleCredentialFile(file);
    const cached = tokens.get(cacheKey);
    if (cached && deps.now() < (expiresAt.get(cacheKey) ?? 0)) return cached;

    // Publish the promise before the first await/mint, including synchronous errors.
    expiresAt.set(cacheKey, Infinity);
    const pending = (async () => {
      await Promise.resolve();
      try {
        const startedAt = deps.now();
        const body = tokenGrant(data, startedAt);
        let response: Response;
        try {
          response = await deps.fetch(TOKEN_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
            signal: AbortSignal.timeout(deps.timeoutMs ?? TOKEN_TIMEOUT_MS),
          });
        } catch {
          throw new Error("Google token endpoint request failed");
        }
        // Never read an error body: it may echo an assertion or access token.
        if (!response.ok) throw new Error(`Google token endpoint failed (${response.status})`);
        let result: unknown;
        try {
          result = await response.json();
        } catch {
          throw new Error("Google token endpoint returned invalid JSON");
        }
        const fields = result && typeof result === "object" ? result as Record<string, unknown> : {};
        if (typeof fields.access_token !== "string" || !fields.access_token) {
          throw new Error("Google token endpoint returned no access_token");
        }
        const seconds = fields.expires_in;
        if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 60) {
          expiresAt.set(cacheKey, startedAt + (seconds - 60) * 1000);
        } else {
          tokens.delete(cacheKey);
          expiresAt.delete(cacheKey);
        }
        // A rotated refresh_token is deliberately discarded, never persisted.
        return fields.access_token;
      } catch (err) {
        tokens.delete(cacheKey);
        expiresAt.delete(cacheKey);
        throw err;
      }
    })();
    tokens.set(cacheKey, pending);
    return pending;
  };
}

const tokenForFile = createTokenResolver({
  fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch,
  now: () => Date.now(),
});

/** Supports both service-account and authorized-user ADC files; tokens stay in memory. */
export async function mintGoogleServiceAccountToken(credentialsPath: string): Promise<string> {
  return tokenForFile(credentialsPath);
}

export async function resolveVertexAccessToken(opts: {
  bearerToken?: string;
  apiKey?: string;
}): Promise<string> {
  const envToken = process.env.GCP_ACCESS_TOKEN?.trim();
  if (envToken) return envToken;

  // An explicit ADC environment path outranks stored/request credential overlays.
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    return tokenForFile(vertexCredentialFile(opts)!);
  }
  const stored = opts.bearerToken?.trim() || opts.apiKey?.trim();
  if (stored && !looksLikeGoogleCredentialPath(stored)) return stored;
  const file = vertexCredentialFile(opts);
  if (file) return tokenForFile(file);

  throw new Error("Vertex AI credentials are missing. Set GCP_ACCESS_TOKEN, GOOGLE_APPLICATION_CREDENTIALS, or configure application-default credentials (ADC).");
}
