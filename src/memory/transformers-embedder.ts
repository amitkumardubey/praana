// ============================================================
// PRAANA Memory — Transformers.js embedder (in-process, deterministic)
// ============================================================

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { appHomePath } from "../app-identity.js";
import { startSpinner, stopSpinner } from "../ui.js";
import { confirmModelDownload } from "../ui/tui/download-consent.js";
import { getEmbedderConsent } from "./embedder-consent.js";
import type { Embedder } from "./types.js";
import {
  resolveTransformersModel,
  type TransformersModelPreset,
} from "./transformers-models.js";

type FeatureExtractionPipeline = (
  text: string,
  options?: { pooling?: "mean"; normalize?: boolean },
) => Promise<{ data: Float32Array }>;

type TransformersModule = {
  env: { cacheDir: string };
  pipeline: (
    task: "feature-extraction",
    model: string,
    options?: {
      progress_callback?: (progress: {
        status?: string;
        file?: string;
        progress?: number;
        loaded?: number;
        total?: number;
      }) => void;
    },
  ) => Promise<FeatureExtractionPipeline>;
};

let transformersModulePromise: Promise<TransformersModule | null> | null = null;
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
let loadedPreset: TransformersModelPreset | null = null;

/** User declined the ONNX weight download — keyword-only recall is expected. */
export class EmbedderDownloadSkipped extends Error {
  constructor() {
    super("embedding model download cancelled by user");
    this.name = "EmbedderDownloadSkipped";
  }
}

/** Reset cached pipeline — for tests only. */
export function resetTransformersEmbedderForTests(): void {
  transformersModulePromise = null;
  pipelinePromise = null;
  loadedPreset = null;
}

async function loadTransformersModule(): Promise<TransformersModule | null> {
  if (!transformersModulePromise) {
    transformersModulePromise = (async () => {
      try {
        const spec = "@huggingface/transformers";
        return (await import(/* webpackIgnore: true */ spec)) as TransformersModule;
      } catch {
        return null;
      }
    })();
  }
  return transformersModulePromise;
}

export async function isTransformersAvailable(): Promise<boolean> {
  return (await loadTransformersModule()) !== null;
}

/**
 * Check whether the ONNX weights for `modelId` are already present in
 * `cacheDir`. The cache layout is `<cacheDir>/<modelId>/onnx/` — if the
 * `onnx` subdirectory exists, the model was downloaded.
 */
export function isModelCached(cacheDir: string, modelId: string): boolean {
  return existsSync(join(cacheDir, modelId, "onnx"));
}

async function loadPipeline(preset: TransformersModelPreset): Promise<FeatureExtractionPipeline> {
  if (pipelinePromise && loadedPreset?.id === preset.id) {
    return pipelinePromise;
  }

  pipelinePromise = (async () => {
    const mod = await loadTransformersModule();
    if (!mod) {
      throw new Error("@huggingface/transformers is not installed");
    }

    const cacheDir = appHomePath("models");
    mkdirSync(cacheDir, { recursive: true });
    mod.env.cacheDir = cacheDir;

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
    }

    let spinnerStarted = false;

    if (process.stderr.isTTY) {
      startSpinner("Loading embedding model…");
      spinnerStarted = true;
    }

    const pipe = await mod.pipeline("feature-extraction", preset.id, {
      progress_callback: (progress) => {
        if (!process.stderr.isTTY) return;

        if (progress.status === "downloading" || progress.status === "progress") {
          const pct =
            typeof progress.progress === "number"
              ? Math.round(progress.progress)
              : progress.total
                ? Math.round(((progress.loaded ?? 0) / progress.total) * 100)
                : undefined;

          const label =
            pct !== undefined
              ? `Loading embedding model (${pct}%)…`
              : "Loading embedding model…";

          if (!spinnerStarted) {
            startSpinner(label);
            spinnerStarted = true;
          } else {
            startSpinner(label);
          }
        }

        if (progress.status === "done" && spinnerStarted) {
          stopSpinner();
          spinnerStarted = false;
        }
      },
    });

    if (spinnerStarted) stopSpinner();
    loadedPreset = preset;
    return pipe;
  })();

  return pipelinePromise;
}

export class TransformersEmbedder implements Embedder {
  readonly dim: number;
  readonly modelId: string;

  private constructor(
    private readonly pipe: FeatureExtractionPipeline,
    preset: TransformersModelPreset,
  ) {
    this.dim = preset.dim;
    this.modelId = preset.id;
  }

  static async create(opts: {
    strategy: string;
    model?: string;
  }): Promise<TransformersEmbedder | null> {
    if (!(await isTransformersAvailable())) return null;

    const preset = resolveTransformersModel(opts.strategy, opts.model);
    try {
      const pipe = await loadPipeline(preset);
      return new TransformersEmbedder(pipe, preset);
    } catch (err) {
      pipelinePromise = null;
      loadedPreset = null;
      if (err instanceof EmbedderDownloadSkipped) throw err;
      stopSpinner();
      return null;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const out = await this.pipe(text, { pooling: "mean", normalize: true });
    return out.data;
  }
}
