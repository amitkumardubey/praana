/**
 * Lazy loader for @praana/natives (napi-rs addon).
 *
 * Never throws into the turn loop — callers inspect NativeLoadResult.
 *
 * Resolution order: npm/workspace `@praana/natives`, then `praana-natives.node`
 * next to `process.execPath` (standalone release archive sidecar).
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  EXPECTED_NATIVE_API_MAJOR,
  NativeUnavailableError,
  type ListImportsResult,
  type ListSymbolsResult,
  type NativeBindings,
  type NativeLoadResult,
  type NativeEmbedResult,
  type NativeFindFilesOpts,
  type NativeFindFilesResult,
  type NativeGrepOpts,
  type NativeGrepResult,
  type ParseFileResult,
  type ProjectHitsResult,
  type ProjectQueryOpts,
} from "./types.js";
import {
  resolveSidecarAddonPath,
  toImportSpecifier,
} from "./sidecar.js";

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
  const grep = asFn<(opts: NativeGrepOpts) => unknown>(mod.grep, "grep");
  const findFiles = asFn<(opts: NativeFindFilesOpts) => unknown>(
    mod.findFiles,
    "findFiles",
  );
  const embedText = asFn<(text: string, modelDir: string) => unknown>(
    mod.embedText,
    "embedText",
  );

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
    grep: (opts) => grep(opts) as NativeGrepResult,
    findFiles: (opts) => findFiles(opts) as NativeFindFilesResult,
    embedText: (text, modelDir) =>
      embedText(text, modelDir) as NativeEmbedResult,
  };
}

function loadResultFromModule(mod: Record<string, unknown>): NativeLoadResult {
  const bindings = asBindings(mod);
  const version = bindings.nativeVersion();
  const major = parseMajor(version);
  if (major === null) {
    const err = new NativeUnavailableError(
      "version_mismatch",
      `native API version unparseable: ${version}`,
    );
    return { available: false, bindings: null, error: err };
  }
  if (major !== EXPECTED_NATIVE_API_MAJOR) {
    const err = new NativeUnavailableError(
      "version_mismatch",
      `native API major ${major} incompatible with expected ${EXPECTED_NATIVE_API_MAJOR}`,
      version,
    );
    return { available: false, bindings: null, error: err };
  }
  return { available: true, bindings, error: null };
}

function nativeCandidates(options?: {
  importSpecifier?: string;
  sidecarPath?: string;
  execPath?: string;
}): string[] {
  const sidecar =
    options?.sidecarPath ??
    resolveSidecarAddonPath(options?.execPath ?? process.execPath);
  const candidates: string[] = [
    options?.importSpecifier ?? "@praana/natives",
  ];
  if (existsSync(sidecar)) {
    candidates.push(sidecar);
  }
  return [...new Set(candidates)];
}

/** Node-API `.node` addons must load via require/dlopen — not dynamic import(). */
export function isNativeAddonPath(candidate: string): boolean {
  return candidate.endsWith(".node");
}

async function loadCandidateModule(
  candidate: string,
  execPath: string,
): Promise<Record<string, unknown>> {
  if (isNativeAddonPath(candidate)) {
    const req = createRequire(execPath);
    return req(candidate) as Record<string, unknown>;
  }
  const specifier = toImportSpecifier(candidate);
  return (await import(specifier)) as Record<string, unknown>;
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
  /** Override first import specifier (tests). Sidecar is still tried if present. */
  importSpecifier?: string;
  /** Override sidecar path (tests). */
  sidecarPath?: string;
  /** Override process.execPath when resolving the default sidecar. */
  execPath?: string;
}): Promise<NativeLoadResult> {
  if (cached && !options?.forceReload) {
    return cached;
  }

  if (!nativeEnabled) {
    const err = new NativeUnavailableError(
      "disabled",
      "native addon disabled via config (native.enabled=false)",
    );
    cached = { available: false, bindings: null, error: err };
    return cached;
  }

  let lastError: unknown;
  const execPath = options?.execPath ?? process.execPath;
  for (const candidate of nativeCandidates(options)) {
    try {
      const mod = await loadCandidateModule(candidate, execPath);
      const result = loadResultFromModule(mod);
      if (result.available) {
        cached = result;
        return cached;
      }
      lastError = result.error;
    } catch (e) {
      lastError = e;
    }
  }

  const causeMessage =
    lastError instanceof Error ? lastError.message : String(lastError ?? "");
  const err =
    lastError instanceof NativeUnavailableError
      ? lastError
      : new NativeUnavailableError(
          "unavailable",
          "native addon failed to load",
          causeMessage,
        );
  cached = { available: false, bindings: null, error: err };
  return cached;
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
