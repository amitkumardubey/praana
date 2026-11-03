import { readFileSync } from "node:fs";

/** Injected by `scripts/compile.ts` via Bun.build `define`; unset when running from source. */
declare const PRAANA_BUILD_VERSION: string | undefined;

function readAppVersion(): string {
  if (typeof PRAANA_BUILD_VERSION === "string" && PRAANA_BUILD_VERSION.length > 0) {
    return PRAANA_BUILD_VERSION.startsWith("v")
      ? PRAANA_BUILD_VERSION
      : `v${PRAANA_BUILD_VERSION}`;
  }
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf-8")) as { version?: string };
    return pkg.version ? `v${pkg.version}` : "v0.0.0";
  } catch {
    return "v0.0.0";
  }
}

/** PRAANA version string. This module does not import config or the LLM drivers. */
export const APP_VERSION = readAppVersion();
