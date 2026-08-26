import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/**
 * Mint a Google Cloud access token from a service-account JSON file.
 * Used for Vertex AI when GOOGLE_APPLICATION_CREDENTIALS is set.
 */
export async function mintGoogleServiceAccountToken(credentialsPath: string): Promise<string> {
  if (!existsSync(credentialsPath)) {
    throw new Error(`GOOGLE_APPLICATION_CREDENTIALS file not found: ${credentialsPath}`);
  }
  const sa = JSON.parse(readFileSync(credentialsPath, "utf8")) as {
    client_email?: string;
    private_key?: string;
  };
  if (!sa.client_email || !sa.private_key) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is not a service-account JSON file");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(sa.private_key).toString("base64url");
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to mint Google access token (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Google token endpoint returned no access_token");
  }
  return data.access_token;
}

export async function resolveVertexAccessToken(opts: {
  bearerToken?: string;
  apiKey?: string;
}): Promise<string> {
  const explicit = opts.bearerToken?.trim();
  if (explicit && !looksLikeFilePath(explicit)) return explicit;

  const envToken = process.env.GCP_ACCESS_TOKEN?.trim();
  if (envToken) return envToken;

  const path =
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
    (opts.apiKey && looksLikeFilePath(opts.apiKey) ? opts.apiKey.trim() : undefined);
  if (path) return mintGoogleServiceAccountToken(path);

  throw new Error(
    'Vertex AI credentials are missing. Set GCP_ACCESS_TOKEN or GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON file.',
  );
}

function looksLikeFilePath(value: string): boolean {
  return (
    value.endsWith(".json") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith("~")
  );
}

function base64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}
