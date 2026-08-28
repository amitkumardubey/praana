import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMissingKeyMessage } from "./llm.js";
import { getConfigWarnings } from "./config.js";
import { appHomePath, APP_NAME } from "./app-identity.js";
import { isModelCached, isTransformersAvailable } from "./memory/transformers-embedder.js";
import { resolveTransformersModel } from "./memory/transformers-models.js";
import { loadNative, formatNativeStatus, tryGetNative } from "./native/index.js";
import { openMemoryDb, upsertEmbedding, searchByVector } from "./memory/db.js";
import type { PraanaConfig } from "./types.js";

export async function handleDoctor(
  config: PraanaConfig,
): Promise<{ success: boolean; lines: string[] }> {
  const lines: string[] = [];
  let success = true;

  lines.push(`${APP_NAME} Doctor`);
  lines.push("");

  const keyError = getMissingKeyMessage(config.llm.provider);
  if (keyError) {
    lines.push(`✗ provider: ${keyError}`);
    success = false;
  } else {
    lines.push(`✓ provider: ${config.llm.provider}`);
  }

  if (!config.llm.model || !config.llm.model.trim()) {
    lines.push("✗ model: not set");
    success = false;
  } else {
    lines.push(`✓ model: ${config.llm.model}`);
  }

  const homeDir = appHomePath();
  try {
    mkdirSync(homeDir, { recursive: true });
    lines.push(`✓ home dir: ${homeDir}`);
  } catch (err) {
    lines.push(`✗ home dir: not writable (${(err as Error).message})`);
    success = false;
  }

  // Native addon (tree-sitter + search + embed runtime)
  let nativeAvailable = false;
  try {
    const loaded = await loadNative();
    const status = formatNativeStatus(loaded);
    if (status.kind === "available") {
      nativeAvailable = true;
      const ping = loaded.bindings?.ping() === "pong" ? "ping ok" : "ping failed";
      lines.push(`✓ native: available (${status.version}, ${ping})`);
    } else {
      const prefix = status.kind === "disabled" ? "disabled" : "unavailable";
      lines.push(`⚠ native: ${prefix}: ${status.reason}`);
    }
  } catch (err) {
    lines.push(`⚠ native: unavailable: ${(err as Error).message}`);
  }

  // Search: real grep against a tiny temp tree
  try {
    const native = await tryGetNative();
    if (!native) {
      lines.push("⚠ search: native grep unavailable (addon not loaded)");
    } else {
      const dir = mkdtempSync(join(tmpdir(), "praana-doctor-search-"));
      try {
        writeFileSync(join(dir, "probe.txt"), "praana-doctor-probe\n");
        const result = native.grep({
          pattern: "praana-doctor-probe",
          path: dir,
          maxResults: 1,
          timeBudgetMs: 2000,
        });
        if (result.ok && result.matches.length >= 1) {
          lines.push("✓ search: native grep available (search_code, find_files)");
        } else {
          lines.push(
            `⚠ search: grep probe failed: ${result.error ?? "no matches"}`,
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch (err) {
    lines.push(`⚠ search: native grep unavailable: ${(err as Error).message}`);
  }

  // Embedder: distinguish addon-missing vs weights-missing vs ready
  const preset = resolveTransformersModel(
    config.memory.embedder ?? "auto",
    config.memory.transformers_model,
  );
  const cacheDir = appHomePath("models");
  const weightsCached = isModelCached(cacheDir, preset.id);
  if (!nativeAvailable) {
    lines.push("⚠ embedder: native addon missing (keyword-only mode)");
  } else if (!(await isTransformersAvailable())) {
    lines.push("⚠ embedder: embed runtime missing (keyword-only mode)");
  } else if (!weightsCached) {
    lines.push(
      `⚠ embedder: runtime ready, weights not downloaded (${preset.id})`,
    );
  } else {
    lines.push(`✓ embedder: native ONNX ready (weights cached: ${preset.id})`);
  }

  // Vectors: BLOB cosine, no SQLite extension
  try {
    const { db } = openMemoryDb(":memory:", 2);
    upsertEmbedding(db, "doctor-probe", new Float32Array([1, 0]));
    const hits = searchByVector(db, new Float32Array([1, 0]), 1);
    db.close();
    if (hits.length === 1 && hits[0]!.entry_id === "doctor-probe") {
      lines.push("✓ vectors: BLOB cosine kNN (no sqlite-vec)");
    } else {
      lines.push("⚠ vectors: BLOB cosine probe returned no hits");
    }
  } catch (err) {
    lines.push(`⚠ vectors: ${((err as Error).message)}`);
  }

  const warnings = getConfigWarnings();
  if (warnings.length > 0) {
    lines.push("");
    lines.push("Configuration warnings:");
    for (const w of warnings) lines.push(`  ⚠ ${w}`);
    success = false;
  }

  lines.push("");
  lines.push(success ? "All checks passed." : "Some checks failed.");

  return { success, lines };
}
