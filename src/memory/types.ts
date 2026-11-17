// ============================================================
// PRAANA Memory — shared embedder type
// ============================================================

export interface Embedder {
  dim: number;
  embed(text: string): Promise<Float32Array>;
}
