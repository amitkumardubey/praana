export {
  EXPECTED_NATIVE_API_MAJOR,
  NativeUnavailableError,
  type ImportHit,
  type ListImportsResult,
  type ListSymbolsResult,
  type NativeBindings,
  type NativeEmbedResult,
  type NativeErrorCode,
  type NativeFindFilesMatch,
  type NativeFindFilesOpts,
  type NativeFindFilesResult,
  type NativeGrepMatch,
  type NativeGrepOpts,
  type NativeGrepResult,
  type NativeLoadResult,
  type ParseDiagnostic,
  type ParseFileResult,
  type ProjectHitsResult,
  type ProjectQueryOpts,
  type SymbolHit,
} from "./types.js";
export {
  isNativeAddonPath,
  isNativeEnabled,
  loadNative,
  resetNativeLoadCache,
  setNativeEnabled,
  tryGetNative,
} from "./load.js";
export {
  SIDECAR_ADDON_FILENAME,
  resolveSidecarAddonPath,
  toImportSpecifier,
} from "./sidecar.js";
export {
  NATIVE_API_VERSION,
  SIDECAR_MANIFEST_FILENAME,
  formatSidecarManifest,
  type SidecarManifest,
} from "./manifest.js";
export {
  formatNativeStatus,
  probeNativeStatus,
  nativeStatusToString,
  type NativeAddonStatus,
} from "./status.js";
