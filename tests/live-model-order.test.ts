import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listModelsForProvider } from "../src/model-listing.js";
import { resetProviderCatalogCacheForTests } from "../src/provider-catalog.js";
import { orderModels } from "../src/ui/tui/overlays/model-selector-items.js";
const original = globalThis.fetch; const home = process.env.PRAANA_HOME;
afterEach(() => { resetProviderCatalogCacheForTests(); globalThis.fetch = original; if (home === undefined) delete process.env.PRAANA_HOME; else process.env.PRAANA_HOME = home; });
test("live creation timestamps order newest first and picker pins current", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-order-")); process.env.PRAANA_HOME = dir; resetProviderCatalogCacheForTests();
  globalThis.fetch = (async () => Response.json({data: [{id: "aa-old", created: 10}, {id: "zz-new", created: 20}, {id: "bb-new", created: 20}]})) as typeof fetch;
  const entries = await listModelsForProvider("openai", {available: true});
  const ids = entries.map(e => e.modelId); expect(ids.indexOf("bb-new")).toBeLessThan(ids.indexOf("zz-new")); expect(ids.indexOf("zz-new")).toBeLessThan(ids.indexOf("aa-old"));
  const ordered = orderModels(entries, "openai", "aa-old"); expect(ordered[0].modelId).toBe("aa-old"); expect(ordered.findIndex(e => e.modelId === "bb-new")).toBeLessThan(ordered.findIndex(e => e.modelId === "zz-new"));
  resetProviderCatalogCacheForTests(); rmSync(dir, {recursive: true, force: true});
});
test("live providers without creation times retain id order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-order-")); process.env.PRAANA_HOME = dir; resetProviderCatalogCacheForTests();
  globalThis.fetch = (async () => Response.json({data: [{id: "zz-last"}, {id: "aa-first"}]})) as typeof fetch;
  const ids = (await listModelsForProvider("openai", {available: true})).map(e => e.modelId);
  expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  resetProviderCatalogCacheForTests(); rmSync(dir, {recursive: true, force: true});
});
