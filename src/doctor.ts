import { mkdirSync, existsSync } from "node:fs";
import { getMissingKeyMessage } from "./llm.js";
import { getConfigWarnings } from "./config.js";
import { appHomePath, APP_NAME } from "./app-identity.js";
import { isTransformersAvailable } from "./memory/transformers-embedder.js";
import { loadNative, formatNativeStatus } from "./native/index.js";
import { probeFffOperational } from "./fff.js";
import type { PraanaConfig } from "./types.js";

export async function handleDoctor(
  config: PraanaConfig,
): Promise<{ success: boolean; lines: string[] }> {
  const lines: string[] = [];
  let success = true;

  lines.push(`${APP_NAME} Doctor`);
  lines.push("");

  // Provider / key check
  const keyError = getMissingKeyMessage(config.llm.provider);
  if (keyError) {
    lines.push(`✗ provider: ${keyError}`);
    success = false;
  } else {
    lines.push(`✓ provider: ${config.llm.provider}`);
  }

  // Model check
  if (!config.llm.model || !config.llm.model.trim()) {
    lines.push("✗ model: not set");
    success = false;
  } else {
    lines.push(`✓ model: ${config.llm.model}`);
  }

  // Home directory writable
  const homeDir = appHomePath();
  try {
    mkdirSync(homeDir, { recursive: true });
    lines.push(`✓ home dir: ${homeDir}`);
  } catch (err) {
    lines.push(`✗ home dir: not writable (${(err as Error).message})`);
    success = false;
  }

  // Embedder availability
  if (await isTransformersAvailable()) {
    lines.push("✓ embedder: transformers available");
  } else {
    lines.push("⚠ embedder: transformers not installed (keyword-only mode)");
  }

  // Native addon availability
  try {
    const status = formatNativeStatus(await loadNative());
    if (status.kind === "available") {
      lines.push(`✓ native: available (${status.version})`);
    } else {
      const prefix = status.kind === "disabled" ? "disabled" : "unavailable";
      lines.push(`⚠ native: ${prefix}: ${status.reason}`);
    }
  } catch (err) {
    lines.push(`⚠ native: unavailable: ${(err as Error).message}`);
  }

  // fff (search_code / find_files) availability — create probe, not dlopen-only
  try {
    const probe = await probeFffOperational("/tmp");
    if (probe.ok) {
      lines.push("✓ search: fff available (search_code, find_files)");
    } else {
      lines.push(`⚠ search: fff unavailable: ${probe.detail}`);
    }
  } catch (err) {
    lines.push(`⚠ search: fff unavailable: ${(err as Error).message}`);
  }

  // Config warnings
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
