import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resetProviderCatalogCacheForTests } from "../src/provider-catalog.js";
import { listAllAvailableModels, listModelsForProvider } from "../src/model-listing.js";
import { getCuratedModels } from "../src/llm/catalog.js";
import { DEFAULT_MODELS } from "../src/llm.js";
import { pickDefaultModel } from "../src/setup/logic.js";
import { resolveModelSpecifier } from "../src/model-resolver.js";
import { resetCredentialStoreForTests, setOAuthToken } from "../src/credentials.js";

const CODEX_MODELS: Array<[id: string, contextWindow: number]> = [
  ["gpt-6.1-sol", 500_000],
  ["gpt-6-astra", 272_000],
  ["gpt-6.1-terra", 500_000],
  ["gpt-6-sol", 272_000],
  ["gpt-6-luna", 272_000],
  ["gpt-5.6-sol", 272_000],
  ["gpt-5.6-terra", 272_000],
  ["gpt-5.6-luna", 272_000],
];

describe("openai-codex model catalog", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    resetProviderCatalogCacheForTests();
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockRejectedValue(new Error("no network in catalog tests"));
    const scratch = join(homedir(), ".cache/codex-fix2-scratch");
    mkdirSync(scratch, { recursive: true });
    home = mkdtempSync(join(scratch, "codex-models-"));
    previousHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = home;
    resetCredentialStoreForTests();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetCredentialStoreForTests();
    resetProviderCatalogCacheForTests();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = previousHome;
  });

  it("lists the eight Codex models when authenticated and none when not", async () => {
    const signedOut = (await listAllAvailableModels()).filter((model) => model.provider === "openai-codex");
    expect(signedOut).toEqual([]);

    setOAuthToken("openai-codex", {
      access: "codex-access",
      refresh: "codex-refresh",
      expires: Date.now() + 3_600_000,
    });
    const signedIn = (await listAllAvailableModels())
      .filter((model) => model.provider === "openai-codex")
      .sort((a, b) => a.modelId.localeCompare(b.modelId));
    expect(signedIn.map((model) => model.modelId)).toEqual(
      CODEX_MODELS.map(([id]) => id).sort((a, b) => a.localeCompare(b)),
    );
    for (const [id, contextWindow] of CODEX_MODELS) {
      expect(signedIn.find((model) => model.modelId === id)).toEqual(
        expect.objectContaining({ provider: "openai-codex", contextWindow, available: true }),
      );
    }
    expect(signedIn.some((model) => model.modelId === "gpt-reserve" || model.modelId === "codex-auto-review")).toBe(false);

    const curated = getCuratedModels("openai-codex");
    expect(curated.map((model) => model.id)).toEqual(CODEX_MODELS.map(([id]) => id));
    expect(curated.every((model) => model.reasoning === true)).toBe(true);
    expect(DEFAULT_MODELS["openai-codex"]).toBe("gpt-6.1-sol");
    expect(CODEX_MODELS.map(([id]) => id)).toContain(DEFAULT_MODELS["openai-codex"]);
    expect(pickDefaultModel("openai-codex")).toBe("gpt-6.1-sol");
  });

  it("rejects bare gpt-5.6 and accepts a listed Codex id", async () => {
    const unknown = await resolveModelSpecifier("gpt-5.6", "openai", "openai-codex");
    expect(unknown).toMatchObject({ provider: "openai-codex", modelId: "gpt-5.6", known: false, source: "model-only" });
    const known = await resolveModelSpecifier("gpt-6.1-sol", "openai", "openai-codex");
    expect(known).toMatchObject({ provider: "openai-codex", modelId: "gpt-6.1-sol", known: true, source: "native-catalog" });
  });
});
