export {
  EXPECTED_NATIVE_API_MAJOR,
  NativeUnavailableError,
  type ImportHit,
  type ListImportsResult,
  type ListSymbolsResult,
  type NativeBindings,
  type NativeErrorCode,
  type NativeLoadResult,
  type ParseDiagnostic,
  type ParseFileResult,
  type ProjectHitsResult,
  type ProjectQueryOpts,
  type SymbolHit,
} from "./types.js";
export {
  isNativeEnabled,
  loadNative,
  resetNativeLoadCache,
  setNativeEnabled,
  tryGetNative,
} from "./load.js";
export {
  formatNativeStatus,
  probeNativeStatus,
  nativeStatusToString,
  type NativeAddonStatus,
} from "./status.js";
