/**
 * Lazy loader for @praana/natives (napi-rs addon).
 *
 * Never throws into the turn loop — callers inspect NativeLoadResult.
 */

import {
  EXPECTED_NATIVE_API_MAJOR,
  NativeUnavailableError,
  type NativeBindings,
  type NativeLoadResult,
} from "./types.js";

let cached: NativeLoadResult | null = null;

function parseMajor(version: string): number | null {
  const match = /^(\d+)\./.exec(version.trim());
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

function asBindings(mod: Record<string, unknown>): NativeBindings {
  const nativeVersion = mod.nativeVersion;
  const ping = mod.ping;
  if (typeof nativeVersion !== "function" || typeof ping !== "function") {
    throw new NativeUnavailableError(
      "unavailable",
      "native addon missing required exports (nativeVersion, ping)",
    );
  }
  return {
    nativeVersion: () => String((nativeVersion as () => unknown)()),
    ping: () => String((ping as () => unknown)()),
  };
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
}

/** Convenience: return bindings or null. */
export async function tryGetNative(): Promise<NativeBindings | null> {
  const result = await loadNative();
  return result.bindings;
}
