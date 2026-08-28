import type { NativeBindings } from "../../src/native/types.js";

export function stubNativeBindings(
  over: Partial<NativeBindings> = {},
): NativeBindings {
  return {
    nativeVersion: () => "0.3.0",
    ping: () => "pong",
    parseFile: () => ({ ok: true, diagnostics: [] }),
    listSymbols: () => ({ ok: true, symbols: [] }),
    listImports: () => ({ ok: true, imports: [] }),
    findDefinition: () => ({
      ok: true,
      hits: [],
      truncated: false,
      filesScanned: 0,
    }),
    findReferences: () => ({
      ok: true,
      hits: [],
      truncated: false,
      filesScanned: 0,
    }),
    grep: () => ({
      ok: true,
      matches: [],
      truncated: false,
      filesSearched: 0,
    }),
    findFiles: () => ({
      ok: true,
      matches: [],
      truncated: false,
      totalMatched: 0,
    }),
    embedText: () => ({
      ok: false,
      dim: 0,
      embedding: [],
      code: "unavailable",
      error: "no model",
    }),
    ...over,
  };
}
