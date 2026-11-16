import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getApiKey, resetCredentialStoreForTests, setApiKey } from "../src/credentials.js";
import { createProvider, getMissingKeyMessage, isProviderAvailable } from "../src/llm.js";
import { PROVIDER_REGISTRY, resetUserProvidersForTests, setUserProviders, SETUP_UNSUPPORTED_PROVIDERS } from "../src/provider-registry.js";
import { formatProvidersCliOutput, listProvidersForCli } from "../src/providers-cli.js";
import { formatModelsCliOutput, listModelsForCli } from "../src/model-listing.js";
import { parseModelCommandArgs, resolveModelSpecifier, resolveModelSpecifierSync } from "../src/model-resolver.js";
import { providerSupportsLiveCatalog } from "../src/provider-catalog.js";
import { buildProviderSelectItems } from "../src/setup/provider-options.js";
import { tryAutoSelectProvider } from "../src/setup/logic.js";
import { useCleanVertexEnv } from "./helpers/vertex-env.js";

useCleanVertexEnv();
const originalFetch = globalThis.fetch;
const originalEntry = PROVIDER_REGISTRY.vertex;
let savedHome: string | undefined;
let fetches: number;
beforeEach(() => {
  savedHome = process.env.PRAANA_HOME;
  process.env.PRAANA_HOME = process.env.CLOUDSDK_CONFIG;
  resetCredentialStoreForTests();
  resetUserProvidersForTests();
  fetches = 0;
  globalThis.fetch = (async () => { fetches++; throw new Error("No network allowed"); }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEntry) PROVIDER_REGISTRY.vertex = originalEntry;
  else delete PROVIDER_REGISTRY.vertex;
  if (savedHome === undefined) delete process.env.PRAANA_HOME;
  else process.env.PRAANA_HOME = savedHome;
  resetCredentialStoreForTests();
  resetUserProvidersForTests();
});
const fakeToken = ["obviously", "fake", "vertex"].join("-");

test("Vertex is registered with a real env key, never a keyless sentinel or live models endpoint", () => {
  expect(PROVIDER_REGISTRY.vertex).toEqual({ api: "google-generative-ai", provider: "vertex", envKey: "GCP_ACCESS_TOKEN", baseUrl: "" });
  const runtime = createProvider({ provider: "vertex", model: "gemini-future-test" })("gemini-future-test");
  expect(runtime.__piOptions?.apiKey).toBe("");
  expect(providerSupportsLiveCatalog("vertex")).toBe(false);
  expect(fetches).toBe(0);
});

test("providers default omits unavailable Vertex; --all names ADC and project configuration", () => {
  expect(listProvidersForCli().some((p) => p.name === "vertex")).toBe(false);
  expect(isProviderAvailable("vertex")).toBe(false);
  const all = listProvidersForCli({ includeUnavailable: true });
  const vertex = all.find((p) => p.name === "vertex");
  expect(vertex?.available).toBe(false);
  expect(vertex?.disabledReason).toContain("ADC");
  expect(vertex?.disabledReason).toContain("VERTEX_PROJECT_ID");
  expect(formatProvidersCliOutput(all)).toContain("vertex (unavailable:");
  expect(fetches).toBe(0);
});

test.each(["token", "stored-token", "stored-file", "env-file", "well-known"])("providers lists Vertex for %s without parsing or contacting Google", (source) => {
  const path = join(process.env.CLOUDSDK_CONFIG!, "application_default_credentials.json");
  // Existence is sufficient for availability; parsing belongs to request time.
  if (source === "token") process.env.GCP_ACCESS_TOKEN = fakeToken;
  else if (source === "stored-token") setApiKey("vertex", fakeToken);
  else if (source === "stored-file") setApiKey("vertex", path);
  else if (source === "env-file") process.env.GOOGLE_APPLICATION_CREDENTIALS = path;
  else writeFileSync(path, "deliberately invalid JSON, not credentials");
  expect(isProviderAvailable("vertex")).toBe(true);
  expect(getMissingKeyMessage("vertex")).toBeNull();
  expect(listProvidersForCli().find((p) => p.name === "vertex")).toEqual({ name: "vertex", available: true });
  expect(fetches).toBe(0);
});

test("user-declared availability stays first even when ambient ADC exists", () => {
  writeFileSync(join(process.env.CLOUDSDK_CONFIG!, "application_default_credentials.json"), "{}");
  expect(isProviderAvailable("vertex")).toBe(true);
  setUserProviders({ vertex: { api: "google-generative-ai", base_url: "https://unused.example.invalid", env_key: "GCP_ACCESS_TOKEN" } });
  expect(isProviderAvailable("vertex")).toBe(false);
  process.env.GCP_ACCESS_TOKEN = fakeToken;
  expect(isProviderAvailable("vertex")).toBe(true);
});

test.each(["gemini-future-test", "gemini-3.8-flash", "gemini-test_123.preview"])("/model accepts uncatalogued %s offline, explicit and current provider", async (id) => {
  expect(parseModelCommandArgs(["/model", "vertex", id])).toMatchObject({ explicitProvider: "vertex", modelSpec: id });
  expect(resolveModelSpecifierSync(id, "google", "vertex")).toMatchObject({ provider: "vertex", modelId: id, known: true, switchedProvider: true });
  expect(await resolveModelSpecifier(id, "vertex")).toMatchObject({ known: true, modelId: id });
  for (const invalid of ["", " ", "123456", "claude-test", "projects/p/locations/l/endpoints/1", "gemini-x/child", "gemini-x?query", "models/gemini-x"]) {
    expect((await resolveModelSpecifier(invalid, "vertex")).known).toBe(false);
    expect(resolveModelSpecifierSync(invalid, "google", "vertex").known).toBe(false);
  }
  expect(fetches).toBe(0);
});

test("models vertex prints no-catalog output whether available or not, without fetch", async () => {
  for (const available of [false, true]) {
    if (available) process.env.GCP_ACCESS_TOKEN = fakeToken;
    const entries = await listModelsForCli("vertex");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ provider: "vertex", modelId: "", available });
    expect(formatModelsCliOutput(entries)).toContain("(no models in catalog)");
  }
  expect(fetches).toBe(0);
});

function registeredVertexForSetup() {
  // Isolate setup's own gate on base too: lack of registration must not mask it.
  PROVIDER_REGISTRY.vertex = { api: "google-generative-ai", provider: "vertex", envKey: "GCP_ACCESS_TOKEN", baseUrl: "" };
  process.env.GCP_ACCESS_TOKEN = fakeToken;
}

test("setup picker excludes Vertex even when a token makes it available", () => {
  registeredVertexForSetup();
  expect(SETUP_UNSUPPORTED_PROVIDERS.has("vertex")).toBe(true);
  expect(buildProviderSelectItems().some((p) => p.value === "vertex")).toBe(false);
});

test("setup never adopts a lone GCP token or pins Vertex's stale default", () => {
  registeredVertexForSetup();
  expect(tryAutoSelectProvider()).toBeNull();
  expect(getApiKey("vertex")).toBeUndefined();
  expect(fetches).toBe(0);
});
