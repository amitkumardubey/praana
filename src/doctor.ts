import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMissingKeyMessage } from "./llm.js";
import { getConfigWarnings } from "./config.js";
import { appHomePath, ensureAppHome, APP_NAME } from "./app-identity.js";
import { isModelCached, isTransformersAvailable } from "./memory/transformers-embedder.js";
import { resolveTransformersModel } from "./memory/transformers-models.js";
import { loadNative, formatNativeStatus, tryGetNative } from "./native/index.js";
import type { PraanaConfig } from "./types.js";

/** Warning lines as printed. Leading whitespace does not hide an indented `⚠`. */
export function countPrintedWarnings(lines: readonly string[]): number {
  return lines.filter((line) => line.trimStart().startsWith("⚠")).length;
}

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
    ensureAppHome();
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

  const warnings = getConfigWarnings();
  if (warnings.length > 0) {
    lines.push("");
    lines.push("Configuration warnings:");
    for (const w of warnings) lines.push(`  ⚠ ${w}`);
    success = false;
  }

  lines.push("");
  // A passing run can still carry warnings (e.g. embedder weights not
  // downloaded). Count every printed warning line, indented or not. Configuration
  // warnings are indented and already set success = false, so they keep the
  // failure summary instead of being folded into this passing tally.
  const warningCount = countPrintedWarnings(lines);
  if (!success) {
    lines.push("Some checks failed.");
  } else if (warningCount > 0) {
    lines.push(
      `All checks passed (${warningCount} warning${warningCount === 1 ? "" : "s"}).`,
    );
  } else {
    lines.push("All checks passed.");
  }

  return { success, lines };
}
