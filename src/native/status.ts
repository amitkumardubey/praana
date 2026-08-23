/**
 * Native addon status formatting and probing (issue #319).
 *
 * `loadNative()` never throws — it always returns a `NativeLoadResult`.
 * These helpers keep the session/compiler layers decoupled from that fact.
 */

import { loadNative } from "./load.js";
import type { NativeLoadResult } from "./types.js";

/**
 * Structured native addon status. Discriminated on `kind` so the compiler can
 * decide via `status.kind === "available"` instead of fragile string matching.
 */
export interface NativeAddonStatusAvailable {
  kind: "available";
  version: string;
}

export interface NativeAddonStatusUnavailable {
  kind: "unavailable" | "disabled";
  reason: string;
}

export type NativeAddonStatus =
  | NativeAddonStatusAvailable
  | NativeAddonStatusUnavailable;

/**
 * Format a `NativeLoadResult` into a structured `NativeAddonStatus`.
 *
 * Uses `error.code` (not message string-matching) to distinguish
 * "disabled" from "unavailable" (issue #319 fix).
 */
export function formatNativeStatus(result: NativeLoadResult): NativeAddonStatus {
  if (result.available && result.bindings) {
    return { kind: "available", version: result.bindings.nativeVersion() };
  }
  const err = result.error;
  if (err?.code === "disabled") {
    return { kind: "disabled", reason: err.message };
  }
  return {
    kind: "unavailable",
    reason: err?.causeMessage ?? err?.message ?? "unknown",
  };
}

/**
 * Probe the native addon once and return a structured status.
 * Safe to call without try/catch — `loadNative()` never throws.
 */
export async function probeNativeStatus(): Promise<NativeAddonStatus> {
  return formatNativeStatus(await loadNative());
}

/**
 * Render a `NativeAddonStatus` as a human-readable string for display surfaces
 * (banners, /stats, etc.).
 */
export function nativeStatusToString(status: NativeAddonStatus): string {
  if (status.kind === "available") return `available (${status.version})`;
  if (status.kind === "disabled") return "disabled via config";
  return `unavailable: ${status.reason}`;
}
