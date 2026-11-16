import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import * as adc from "../src/llm/google-adc.js";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import { resolveProviderAuth } from "../src/llm/auth.js";
import { completeLlmResponse } from "../src/llm/stream.js";
import { resetCredentialStoreForTests, setApiKey } from "../src/credentials.js";
import { useCleanVertexEnv } from "./helpers/vertex-env.js";
import { googleSse } from "./helpers/google-thought-signature.js";

useCleanVertexEnv();
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const fake = (kind: string) => ["obviously", "fake", kind].join("-");
let now: number;
let calls: Array<{ url: string; body: URLSearchParams }>;
let savedPraanaHome: string | undefined;
let logged: string[];
let logSpies: Array<{ mockRestore(): void }>;

beforeEach(() => {
  now = 1_000_000;
  Date.now = () => now;
  calls = [];
  logged = [];
  logSpies = ["log", "warn", "error", "debug", "info"].map((method) =>
    spyOn(console, method as "log").mockImplementation((...args) => { logged.push(args.join(" ")); }));
  savedPraanaHome = process.env.PRAANA_HOME;
  process.env.PRAANA_HOME = process.env.CLOUDSDK_CONFIG;
  resetCredentialStoreForTests();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
    return Response.json({ access_token: fake("access"), expires_in: 3600, refresh_token: fake("rotated-discard") });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  for (const spy of logSpies) spy.mockRestore();
  if (savedPraanaHome === undefined) delete process.env.PRAANA_HOME;
  else process.env.PRAANA_HOME = savedPraanaHome;
  resetCredentialStoreForTests();
});

function file(data: unknown, name = "adc.json"): string {
  const path = join(process.env.CLOUDSDK_CONFIG!, name);
  writeFileSync(path, JSON.stringify(data));
  return path;
}
function user(extra: Record<string, unknown> = {}) {
  return { type: "authorized_user", client_id: fake("client"), client_secret: fake("secret"), refresh_token: fake("refresh"), ...extra };
}
async function serializedError(fn: () => Promise<unknown>): Promise<string> {
  let caught: unknown;
  try { await fn(); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  return JSON.stringify(caught, Object.getOwnPropertyNames(caught));
}

test("authorized_user sends only a refresh grant and never persists a rotated refresh token", async () => {
  const path = file(user());
  const before = readFileSync(path, "utf8");
  expect(await adc.mintGoogleServiceAccountToken(path)).toBe(fake("access"));
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
  expect(Object.fromEntries(calls[0].body)).toEqual({ grant_type: "refresh_token", client_id: fake("client"), client_secret: fake("secret"), refresh_token: fake("refresh") });
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(logged.join("\n")).not.toContain(fake("secret"));
  expect(logged.join("\n")).not.toContain(fake("access"));
});

test("service-account signing still works and tokens cache until 60 seconds before expiry", async () => {
  // Ephemeral local key: never a secret literal in a public fixture.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const path = file({ type: "service_account", client_email: "fake@example.invalid", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
  expect(await adc.mintGoogleServiceAccountToken(path)).toBe(fake("access"));
  const grant = calls[0].body;
  expect(grant.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
  const payload = JSON.parse(Buffer.from(grant.get("assertion")!.split(".")[1], "base64url").toString());
  expect(payload).toMatchObject({ iss: "fake@example.invalid", scope: "https://www.googleapis.com/auth/cloud-platform", iat: 1000, exp: 4600 });
  now += 3_539_000;
  expect(await adc.mintGoogleServiceAccountToken(path)).toBe(fake("access"));
  expect(calls).toHaveLength(1);
  now += 1_000;
  await adc.mintGoogleServiceAccountToken(path);
  expect(calls).toHaveLength(2);
});

test("concurrent callers share one in-flight mint, including failure; the next call retries", async () => {
  const path = file(user());
  let release!: () => void;
  let requests = 0;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async () => { requests++; await wait; return Response.json({}, { status: requests === 1 ? 400 : 200 }); }) as typeof fetch;
  const pending = [adc.mintGoogleServiceAccountToken(path), adc.mintGoogleServiceAccountToken(path)];
  await Promise.resolve();
  expect(requests).toBe(1);
  release();
  const results = await Promise.allSettled(pending);
  expect(results.every((r) => r.status === "rejected")).toBe(true);
  if (results[0].status === "rejected" && results[1].status === "rejected") expect(results[0].reason).toBe(results[1].reason);
  globalThis.fetch = (async () => { requests++; return Response.json({ access_token: fake("retried"), expires_in: 3600 }); }) as typeof fetch;
  expect(await adc.mintGoogleServiceAccountToken(path)).toBe(fake("retried"));
  expect(requests).toBe(2);
});

test("a timed-out token mint fails safely and a subsequent call retries", async () => {
  const path = file(user());
  let requests = 0;
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    if (requests > 1) return Response.json({ access_token: fake("retried"), expires_in: 3600 });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof globalThis.fetch;
  const tokenForFile = adc.createTokenResolver({ fetch, now: () => now, timeoutMs: 10 });
  const pending = [tokenForFile(path), tokenForFile(path)];
  const results = await Promise.allSettled(pending);
  expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  for (const result of results) {
    if (result.status === "rejected") expect(result.reason.message).toBe("Google token endpoint request failed");
  }
  expect(requests).toBe(1);
  expect(await tokenForFile(path)).toBe(fake("retried"));
  expect(requests).toBe(2);
}, 500);

test("token mints use a 30-second timeout by default", async () => {
  const timeout = spyOn(AbortSignal, "timeout");
  try {
    await adc.mintGoogleServiceAccountToken(file(user()));
    expect(timeout).toHaveBeenCalledWith(30_000);
  } finally {
    timeout.mockRestore();
  }
});

test("successful concurrent callers share one token", async () => {
  const path = file(user());
  const tokens = await Promise.all(Array.from({ length: 8 }, () => adc.mintGoogleServiceAccountToken(path)));
  expect(tokens).toEqual(Array(8).fill(fake("access")));
  expect(calls).toHaveLength(1);
});

test.each([undefined, "3600", null, NaN, 30].map((expiry) => [expiry]))("expires_in %p uses the token once without caching", async (expires_in) => {
  const path = file(user());
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json({ access_token: fake("one-shot"), expires_in }); }) as typeof fetch;
  expect(await adc.mintGoogleServiceAccountToken(path)).toBe(fake("one-shot"));
  expect(await adc.mintGoogleServiceAccountToken(path)).toBe(fake("one-shot"));
  expect(requests).toBe(2);
});

test("file size/mtime/inode changes invalidate the token cache and symlink swaps use the read descriptor", async () => {
  const a = file(user(), "a.json");
  const b = file(user({ client_id: fake("second-client") }), "b.json");
  const link = join(process.env.CLOUDSDK_CONFIG!, "link.json");
  symlinkSync(a, link);
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    if (requests === 1) { unlinkSync(link); symlinkSync(b, link); }
    return Response.json({ access_token: fake(`access-${requests}`), expires_in: 3600 });
  }) as typeof fetch;
  expect(await adc.mintGoogleServiceAccountToken(link)).toBe(fake("access-1"));
  expect(await adc.mintGoogleServiceAccountToken(link)).toBe(fake("access-2"));
  expect(await adc.mintGoogleServiceAccountToken(link)).toBe(fake("access-2"));
  utimesSync(b, new Date(5000), new Date(5000));
  expect(await adc.mintGoogleServiceAccountToken(link)).toBe(fake("access-3"));
  writeFileSync(b, JSON.stringify(user({ client_id: fake("a-longer-client-name") })));
  expect(await adc.mintGoogleServiceAccountToken(link)).toBe(fake("access-4"));
  expect(requests).toBe(4);
});

test("malformed JSON never appears in a serialized credential error", async () => {
  const path = file({});
  const secret = fake("private-refresh-bytes");
  writeFileSync(path, `{"private_key":"${secret}", NOT JSON`);
  const message = await serializedError(() => adc.mintGoogleServiceAccountToken(path));
  expect(message).toContain("Invalid Google ADC credential JSON");
  expect(message).not.toContain(secret);
  expect(message).not.toContain("NOT JSON");
});

test.each(["external_account", { private_key: "should-not-serialize" }].map((type) => [type]))("unsupported credential type %p is safe and explicit", async (type) => {
  const path = file({ ...user(), type });
  const message = await serializedError(() => adc.mintGoogleServiceAccountToken(path));
  expect(message).toContain("Unsupported Google ADC credential type");
  if (typeof type === "string") expect(message).toContain(type);
  else expect(message).not.toContain("should-not-serialize");
  expect(message).not.toContain(fake("secret"));
  expect(message).not.toContain(fake("refresh"));
});

for (const field of ["client_id", "client_secret", "refresh_token", "client_email", "private_key"]) {
  test(`${field} must be a string and errors never serialize credential fields`, async () => {
    const data = field.startsWith("client_e") || field === "private_key"
      ? { type: "service_account", client_email: "fake@example.invalid", private_key: fake("private"), [field]: { value: fake("nested-private") } }
      : user({ [field]: { value: fake("nested-private") } });
    const message = await serializedError(() => adc.mintGoogleServiceAccountToken(file(data)));
    expect(message).toContain("Invalid Google ADC");
    for (const kind of ["nested-private", "private", "secret", "refresh"]) expect(message).not.toContain(fake(kind));
    expect(calls).toHaveLength(0);
  });
}

test("token endpoint HTTP, network and JSON failures never echo provider or credential bytes", async () => {
  const path = file(user());
  const secret = fake("echoed-access-and-assertion");
  for (const response of [() => new Response(secret, { status: 401 }), () => new Response(secret, { status: 200 }), () => { throw new Error(secret); }]) {
    globalThis.fetch = (async () => response()) as typeof fetch;
    const message = await serializedError(() => adc.mintGoogleServiceAccountToken(path));
    expect(message).toContain("Google token endpoint");
    expect(message).not.toContain(secret);
    expect(message).not.toContain(fake("refresh"));
    expect(message).not.toContain(fake("secret"));
    expect(logged.join("\n")).not.toContain(secret);
    expect(logged.join("\n")).not.toContain(fake("refresh"));
  }
});

test("credential path helpers resolve Windows, relative and leading-tilde paths from runtime home", () => {
  const helpers = adc as unknown as { resolveGoogleCredentialPath: (v: string, o: object) => string; wellKnownGoogleAdcPath: (o: object) => string };
  expect(helpers.resolveGoogleCredentialPath).toBeFunction();
  const opts = { platform: "win32", pathImpl: win32, cwd: "C:\\work", env: { USERPROFILE: "C:\\fake-home", APPDATA: "C:\\fake-roaming" } };
  expect(helpers.resolveGoogleCredentialPath("~\\keys\\fake.json", opts)).toBe("C:\\fake-home\\keys\\fake.json");
  expect(helpers.resolveGoogleCredentialPath("D:\\keys\\fake.json", opts)).toBe("D:\\keys\\fake.json");
  expect(helpers.resolveGoogleCredentialPath("keys\\fake.json", opts)).toBe("C:\\work\\keys\\fake.json");
  expect(helpers.wellKnownGoogleAdcPath(opts)).toBe("C:\\fake-roaming\\gcloud\\application_default_credentials.json");
  expect(helpers.wellKnownGoogleAdcPath({ ...opts, env: { ...opts.env, CLOUDSDK_CONFIG: "~\\sdk" } })).toBe("C:\\fake-home\\sdk\\application_default_credentials.json");
  expect(helpers.wellKnownGoogleAdcPath({ env: { HOME: "/fake-home" }, cwd: "/work", platform: "linux" })).toBe("/fake-home/.config/gcloud/application_default_credentials.json");
});

test("stored paths (including ~) and well-known ADC pass the stream authentication gate", () => {
  const path = file(user(), "application_default_credentials.json");
  expect(resolveProviderAuth("vertex")).toEqual({ googleAdc: true });
  setApiKey("vertex", path);
  expect(resolveProviderAuth("vertex")?.googleAdc).toBe(true);
  setApiKey("vertex", "~fake-adc");
  expect(resolveProviderAuth("vertex")?.googleAdc).toBe(true);
  expect(resolveProviderAuth("vertex")?.bearerToken).toBeUndefined();
});

test("final streaming auth precedence survives request-level stored token overlays", async () => {
  process.env.VERTEX_PROJECT_ID = "fake-project";
  const envFile = file(user());
  process.env.GOOGLE_APPLICATION_CREDENTIALS = envFile;
  setApiKey("vertex", fake("stored"));
  const tokens: string[] = [];
  let mints = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("oauth2.googleapis.com")) { mints++; return Response.json({ access_token: fake("adc"), expires_in: 3600 }); }
    tokens.push(new Headers(init?.headers).get("authorization")!);
    return googleSse([{ text: "ok" }]);
  }) as typeof fetch;
  const run = () => completeLlmResponse({ provider: "vertex", model: "gemini-test", messages: [], apiKey: fake("stored"), bearerToken: fake("stored-overlay") });
  process.env.GCP_ACCESS_TOKEN = fake("env");
  expect((await run()).finalReason).toBe("stop");
  delete process.env.GCP_ACCESS_TOKEN;
  expect((await run()).finalReason).toBe("stop");
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  expect((await run()).finalReason).toBe("stop");
  expect(tokens).toEqual([`Bearer ${fake("env")}`, `Bearer ${fake("adc")}`, `Bearer ${fake("stored-overlay")}`]);
  expect(mints).toBe(1);
});

test("missing credential files retain a clear local error without an HTTP auth status", async () => {
  process.env.VERTEX_PROJECT_ID = "fake-project";
  process.env.GOOGLE_APPLICATION_CREDENTIALS = join(process.env.CLOUDSDK_CONFIG!, "missing.json");
  const events = [];
  for await (const event of new GoogleDriver().stream({ provider: "vertex", model: "gemini-test", messages: [] }, {})) events.push(event);
  const error = events.find((e) => e.type === "error");
  expect(error?.type).toBe("error");
  if (error?.type === "error") {
    expect(error.status).toBeUndefined();
    expect(error.error.message).toContain("file not found");
  }
  expect(calls).toHaveLength(0);
});
