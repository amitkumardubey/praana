/**
 * Sidecar native addon next to a compiled praana binary.
 *
 * Bun `--compile` cannot embed a `.node` shared library. Release archives
 * place `praana-natives.node` beside `praana`; the loader dlopens that path
 * when `@praana/natives` is not installed (standalone / curl-installer).
 */
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Filename packed next to the standalone `praana` executable. */
export const SIDECAR_ADDON_FILENAME = "praana-natives.node";

export {
  NATIVE_API_VERSION,
  SIDECAR_MANIFEST_FILENAME,
  formatSidecarManifest,
  type SidecarManifest,
} from "./manifest.js";

export function resolveSidecarAddonPath(
  execPath: string = process.execPath,
): string {
  return join(dirname(execPath), SIDECAR_ADDON_FILENAME);
}

/** Convert a filesystem path to something `import()` can load. */
export function toImportSpecifier(candidate: string): string {
  if (candidate.startsWith("file:") || candidate.startsWith("@")) {
    return candidate;
  }
  if (isAbsolute(candidate)) {
    return pathToFileURL(candidate).href;
  }
  return candidate;
}
