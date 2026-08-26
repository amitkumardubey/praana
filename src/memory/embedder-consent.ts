import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appHomePath } from "../app-identity.js";
import type { MemoryConfig } from "../types.js";
import { resolveTransformersModel } from "./transformers-models.js";

export type EmbedderConsent = "proceed" | "skip";

function consentPath(): string {
  return appHomePath(".embedder-consent");
}

/** Recorded HuggingFace-weight download choice, or null if the user has not answered. */
export function getEmbedderConsent(): EmbedderConsent | null {
  const path = consentPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (raw === "proceed" || raw === "skip") return raw;
  } catch {
    // ignore unreadable consent file
  }
  return null;
}

export function setEmbedderConsent(value: EmbedderConsent): void {
  mkdirSync(appHomePath(), { recursive: true });
  writeFileSync(consentPath(), `${value}\n`, "utf-8");
}

function isTransformersStrategy(strategy: string | undefined): boolean {
  return (
    strategy === undefined ||
    strategy === "auto" ||
    strategy === "transformers" ||
    strategy === "transformers-nomic"
  );
}

function isOnnxCached(modelId: string): boolean {
  return existsSync(join(appHomePath("models"), modelId, "onnx"));
}

/**
 * True when an interactive TTY would otherwise spawn a nested download-consent TUI.
 * Headless / non-TTY callers auto-proceed and do not need an overlay.
 */
export function needsInteractiveEmbedderConsent(memory?: MemoryConfig): boolean {
  if (!process.stderr.isTTY) return false;
  if (getEmbedderConsent() !== null) return false;
  const strategy = memory?.embedder ?? "auto";
  if (!isTransformersStrategy(strategy)) return false;
  const preset = resolveTransformersModel(strategy, memory?.transformers_model);
  return !isOnnxCached(preset.id);
}
