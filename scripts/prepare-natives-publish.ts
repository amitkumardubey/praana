#!/usr/bin/env bun
/**
 * Inject platform optionalDependencies into `@praana/natives` before npm publish.
 *
 * Leaf packages (`@praana/natives-linux-x64-gnu`, …) are created in CI by
 * `napi create-npm-dirs` and are not committed. This script pins them on the
 * root addon package at the same version so `bun add -g praana` pulls the
 * correct `.node` without a Rust toolchain.
 *
 * Usage:
 *   bun run scripts/prepare-natives-publish.ts
 *   bun run scripts/prepare-natives-publish.ts -- --package-json packages/praana-natives/package.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const NATIVE_PLATFORM_PACKAGES = [
  "@praana/natives-darwin-arm64",
  "@praana/natives-darwin-x64",
  "@praana/natives-linux-arm64-gnu",
  "@praana/natives-linux-x64-gnu",
  "@praana/natives-linux-x64-musl",
  "@praana/natives-win32-x64-msvc",
] as const;

const DEFAULT_PACKAGE_JSON = "packages/praana-natives/package.json";

export function nativesOptionalDependencies(
  version: string,
): Record<string, string> {
  return Object.fromEntries(
    NATIVE_PLATFORM_PACKAGES.map((name) => [name, version]),
  );
}

export function applyNativesOptionalDependencies(
  pkg: Record<string, unknown>,
  version: string,
): Record<string, unknown> {
  return {
    ...pkg,
    optionalDependencies: nativesOptionalDependencies(version),
  };
}

function parseArgs(argv: string[]): { packageJson: string; help: boolean } {
  let packageJson = DEFAULT_PACKAGE_JSON;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--package-json") {
      const next = argv[++i];
      if (!next) throw new Error("--package-json requires a path");
      packageJson = next;
      continue;
    }
    if (arg.startsWith("--package-json=")) {
      packageJson = arg.slice("--package-json=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { packageJson, help };
}

function printHelp(): void {
  console.log(`Inject platform optionalDependencies into @praana/natives.

Usage:
  bun run scripts/prepare-natives-publish.ts [--package-json <path>]

Default:
  --package-json ${DEFAULT_PACKAGE_JSON}
`);
}

export function prepareNativesPublish(packageJsonPath: string): {
  version: string;
  optionalDependencies: Record<string, string>;
} {
  const path = resolve(packageJsonPath);
  const pkg = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  if (!version) {
    throw new Error(`${path} is missing a version field`);
  }
  const next = applyNativesOptionalDependencies(pkg, version);
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return {
    version,
    optionalDependencies: nativesOptionalDependencies(version),
  };
}

async function main(): Promise<void> {
  const { packageJson, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }
  const result = prepareNativesPublish(packageJson);
  console.log(
    `Pinned ${Object.keys(result.optionalDependencies).length} platform packages at ${result.version}`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
