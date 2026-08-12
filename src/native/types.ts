/**
 * Native capability boundary types (issue #313).
 * See docs/superpowers/specs/2026-08-11-rust-native-runtime-design.md
 */

/** Major-compatible API version expected by this PRAANA tree. */
export const EXPECTED_NATIVE_API_MAJOR = 0;

export type NativeErrorCode =
  | "unavailable"
  | "version_mismatch"
  | "invalid_argument"
  | "io_error"
  | "parse_error"
  | "unsupported_language"
  | "cancelled"
  | "internal";

export class NativeUnavailableError extends Error {
  readonly code: NativeErrorCode;
  readonly causeMessage?: string;

  constructor(code: NativeErrorCode, message: string, causeMessage?: string) {
    super(message);
    this.name = "NativeUnavailableError";
    this.code = code;
    this.causeMessage = causeMessage;
  }
}

/** Minimal bindings for skeleton (#313). Expanded by #11. */
export interface NativeBindings {
  nativeVersion(): string;
  ping(): string;
}

export interface NativeLoadResult {
  available: boolean;
  bindings: NativeBindings | null;
  error: NativeUnavailableError | null;
}
