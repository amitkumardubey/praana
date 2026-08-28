// ============================================================
// PRAANA Memory — native ONNX embedder (weights cached in ~/.praana/models)
// ============================================================

import {
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { appHomePath } from "../app-identity.js";
import { startSpinner, stopSpinner } from "../ui.js";
import { confirmModelDownload } from "../ui/tui/download-consent.js";
import { getEmbedderConsent } from "./embedder-consent.js";
import type { Embedder } from "./types.js";
import {
  resolveTransformersModel,
  type TransformersModelPreset,
} from "./transformers-models.js";
import { tryGetNative, type NativeBindings } from "../native/index.js";

/** User declined the ONNX weight download — keyword-only recall is expected. */
export class EmbedderDownloadSkipped extends Error {
  constructor() {
    super("embedding model download cancelled by user");
    this.name = "EmbedderDownloadSkipped";
  }
}

/** Reset cached pipeline — for tests only. */
export function resetTransformersEmbedderForTests(): void {
  // Native model cache lives in the addon; TS only needs a no-op reset hook.
}

export async function isTransformersAvailable(): Promise<boolean> {
  return (await tryGetNative()) !== null;
}

/**
 * Check whether tokenizer + ONNX weights for `modelId` are in `cacheDir`.
 * Layout: `<cacheDir>/<modelId>/tokenizer.json` and `<cacheDir>/<modelId>/onnx/`.
 */
export function isModelCached(cacheDir: string, modelId: string): boolean {
  const dir = join(cacheDir, modelId);
  if (!existsSync(join(dir, "tokenizer.json"))) return false;
  return (
    existsSync(join(dir, "onnx", "model_quantized.onnx")) ||
    existsSync(join(dir, "onnx", "model.onnx")) ||
    existsSync(join(dir, "model_quantized.onnx"))
  );
}

function hfFileUrl(modelId: string, relativePath: string): string {
  return `https://huggingface.co/${modelId}/resolve/main/${relativePath}`;
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed (${res.status}) ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);
}

async function ensureModelFiles(
  cacheDir: string,
  preset: TransformersModelPreset,
): Promise<string> {
  const modelDir = join(cacheDir, preset.id);
  mkdirSync(join(modelDir, "onnx"), { recursive: true });

  if (!isModelCached(cacheDir, preset.id)) {
    const recorded = getEmbedderConsent();
    const allowed =
      recorded === "proceed"
        ? true
        : recorded === "skip"
          ? false
          : await confirmModelDownload(preset.id);
    if (!allowed) {
      throw new EmbedderDownloadSkipped();
    }

    let spinnerStarted = false;
    if (process.stderr.isTTY) {
      startSpinner(`Downloading embedding model ${preset.id}…`);
      spinnerStarted = true;
    }
    try {
      await downloadToFile(
        hfFileUrl(preset.id, "tokenizer.json"),
        join(modelDir, "tokenizer.json"),
      );
      await downloadToFile(
        hfFileUrl(preset.id, "onnx/model_quantized.onnx"),
        join(modelDir, "onnx", "model_quantized.onnx"),
      );
    } finally {
      if (spinnerStarted) stopSpinner();
    }
  }

  return modelDir;
}

export class TransformersEmbedder implements Embedder {
  readonly dim: number;
  readonly modelId: string;

  private constructor(
    private readonly native: NativeBindings,
    private readonly modelDir: string,
    preset: TransformersModelPreset,
  ) {
    this.dim = preset.dim;
    this.modelId = preset.id;
  }

  static async create(opts: {
    strategy: string;
    model?: string;
  }): Promise<TransformersEmbedder | null> {
    const native = await tryGetNative();
    if (!native) return null;

    const preset = resolveTransformersModel(opts.strategy, opts.model);
    try {
      const cacheDir = appHomePath("models");
      mkdirSync(cacheDir, { recursive: true });
      const modelDir = await ensureModelFiles(cacheDir, preset);
      return new TransformersEmbedder(native, modelDir, preset);
    } catch (err) {
      if (err instanceof EmbedderDownloadSkipped) throw err;
      stopSpinner();
      return null;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const result = this.native.embedText(text, this.modelDir);
    if (!result.ok) {
      throw new Error(result.error ?? "native embed failed");
    }
    return Float32Array.from(result.embedding);
  }
}
