// ============================================================
// PRAANA Memory — Transformers.js model presets
// ============================================================

export interface TransformersModelPreset {
  id: string;
  dim: number;
}

export const TRANSFORMERS_MODEL_PRESETS: Record<string, TransformersModelPreset> = {
  default: {
    id: "Xenova/all-MiniLM-L6-v2",
    dim: 384,
  },
  nomic: {
    id: "Xenova/nomic-embed-text-v1",
    dim: 768,
  },
};

export function resolveTransformersModel(
  strategy: string,
  explicitModel?: string,
): TransformersModelPreset {
  if (explicitModel?.trim()) {
    const known = Object.values(TRANSFORMERS_MODEL_PRESETS).find(
      (p) => p.id === explicitModel.trim(),
    );
    return known ?? { id: explicitModel.trim(), dim: 384 };
  }

  if (strategy === "transformers-nomic") {
    return TRANSFORMERS_MODEL_PRESETS.nomic;
  }

  return TRANSFORMERS_MODEL_PRESETS.default;
}
