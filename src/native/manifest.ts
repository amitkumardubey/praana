/** Sidecar JSON next to `praana-natives.node` in standalone archives. */
export const SIDECAR_MANIFEST_FILENAME = "praana-natives.json";

/** Must match `NATIVE_API_VERSION` in crates/praana-natives/src/lib.rs. */
export const NATIVE_API_VERSION = "0.3.0";

export interface SidecarManifest {
  apiVersion: string;
  target: string;
  sha256: string;
}

export function formatSidecarManifest(manifest: SidecarManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
