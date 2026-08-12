/**
 * Lazy loader for @praana/natives (napi-rs addon).
 *
 * Never throws into the turn loop — callers inspect NativeLoadResult.
 */

import {
  EXPECTED_NATIVE_API_MAJOR,
  NativeUnavailableError,
  type ListImportsResult,
  type ListSymbolsResult,
  type NativeBindings,
  type NativeLoadResult,
  type ParseFileResult,
  type ProjectHitsResult,
  type ProjectQueryOpts,
} from "./types.js";

let cached: NativeLoadResult | null = null;
/** When false, loadNative short-circuits as unavailable (from [native] enabled). */
let nativeEnabled = true;

function parseMajor(version: string): number | null {
  const match = /^(\d+)\./.exec(version.trim());
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

function asFn<T extends (...args: never[]) => unknown>(
  value: unknown,
  name: string,
): T {
  if (typeof value !== "function") {
    throw new NativeUnavailableError(
      "unavailable",
      `native addon missing required export (${name})`,
    );
  }
  return value as T;
}

function asBindings(mod: Record<string, unknown>): NativeBindings {
  const nativeVersion = asFn<() => unknown>(mod.nativeVersion, "nativeVersion");
  const ping = asFn<() => unknown>(mod.ping, "ping");
  const parseFile = asFn<(path: string, language?: string | null) => unknown>(
    mod.parseFile,
    "parseFile",
  );
  const listSymbols = asFn<(path: string, language?: string | null) => unknown>(
    mod.listSymbols,
    "listSymbols",
  );
  const listImports = asFn<(path: string, language?: string | null) => unknown>(
    mod.listImports,
    "listImports",
  );
  const findDefinition = asFn<
    (root: string, symbol: string, opts?: ProjectQueryOpts | null) => unknown
  >(mod.findDefinition, "findDefinition");
  const findReferences = asFn<
    (root: string, symbol: string, opts?: ProjectQueryOpts | null) => unknown
  >(mod.findReferences, "findReferences");

  return {
    nativeVersion: () => String(nativeVersion()),
    ping: () => String(ping()),
    parseFile: (path, language) => parseFile(path, language) as ParseFileResult,
    listSymbols: (path, language) =>
      listSymbols(path, language) as ListSymbolsResult,
    listImports: (path, language) =>
      listImports(path, language) as ListImportsResult,
    findDefinition: (root, symbol, opts) =>
      findDefinition(root, symbol, opts) as ProjectHitsResult,
    findReferences: (root, symbol, opts) =>
      findReferences(root, symbol, opts) as ProjectHitsResult,
  };
}

/**
 * Configure whether the loader may attempt to dlopen the addon.
 * Called from session/config wiring; tests may reset via resetNativeLoadCache.
 */
export function setNativeEnabled(enabled: boolean): void {
  nativeEnabled = enabled;
  cached = null;
}

export function isNativeEnabled(): boolean {
  return nativeEnabled;
}

/**
 * Attempt to load the native addon once. Subsequent calls return the cache.
 * Pass `forceReload` in tests only.
 */
export async function loadNative(options?: {
  forceReload?: boolean;
  /** Override import specifier (tests). */
  importSpecifier?: string;
}): Promise<NativeLoadResult> {
  if (cached && !options?.forceReload) {
    return cached;
  }

  if (!nativeEnabled) {
    const err = new NativeUnavailableError(
      "unavailable",
      "native addon disabled via config (native.enabled=false)",
    );
    cached = { available: false, bindings: null, error: err };
    return cached;
  }

  const specifier = options?.importSpecifier ?? "@praana/natives";

  try {
    const mod = (await import(specifier)) as Record<string, unknown>;
    const bindings = asBindings(mod);
    const version = bindings.nativeVersion();
    const major = parseMajor(version);
    if (major === null) {
      const err = new NativeUnavailableError(
        "version_mismatch",
        `native API version unparseable: ${version}`,
      );
      cached = { available: false, bindings: null, error: err };
      return cached;
    }
    if (major !== EXPECTED_NATIVE_API_MAJOR) {
      const err = new NativeUnavailableError(
        "version_mismatch",
        `native API major ${major} incompatible with expected ${EXPECTED_NATIVE_API_MAJOR}`,
        version,
      );
      cached = { available: false, bindings: null, error: err };
      return cached;
    }
    cached = { available: true, bindings, error: null };
    return cached;
  } catch (e) {
    const causeMessage = e instanceof Error ? e.message : String(e);
    const err =
      e instanceof NativeUnavailableError
        ? e
        : new NativeUnavailableError(
            "unavailable",
            "native addon failed to load",
            causeMessage,
          );
    cached = { available: false, bindings: null, error: err };
    return cached;
  }
}

/** Reset cache — tests only. */
export function resetNativeLoadCache(): void {
  cached = null;
  nativeEnabled = true;
}

/** Convenience: return bindings or null. */
export async function tryGetNative(): Promise<NativeBindings | null> {
  const result = await loadNative();
  return result.bindings;
}
