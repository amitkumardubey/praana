#!/usr/bin/env bun
/**
 * Compile a standalone praana binary with the OpenTUI Solid JSX transform.
 *
 * Plain `bun build --compile` is not enough: Solid needs the bun-plugin, and the
 * binary must disable bunfig autoload so a cwd `preload = ["@opentui/solid/preload"]`
 * does not break launches from this repo (or any OpenTUI project).
 *
 * Versioning:
 *   - On exact tag `v{package.json version}` with a clean tree → `0.12.0`
 *   - Otherwise → `0.12.0-dev.<shortsha>[.dirty]` so unreleased builds are honest
 *
 * Usage:
 *   bun run build:compile
 *   bun run build:compile -- --target bun-linux-x64
 *   bun run build:compile -- --outfile dist/praana-linux
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";

const DEFAULT_OUTFILE = "dist/praana";

function parseArgs(argv: string[]): {
  target?: string;
  outfile: string;
  help: boolean;
} {
  let target: string | undefined;
  let outfile = DEFAULT_OUTFILE;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--target") {
      const next = argv[++i];
      if (!next) throw new Error("--target requires a value (e.g. bun-linux-x64)");
      target = next;
      continue;
    }
    if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
      continue;
    }
    if (arg === "--outfile") {
      const next = argv[++i];
      if (!next) throw new Error("--outfile requires a path");
      outfile = next;
      continue;
    }
    if (arg.startsWith("--outfile=")) {
      outfile = arg.slice("--outfile=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { target, outfile, help };
}

function printHelp(): void {
  console.log(`Compile a standalone praana executable.

Usage:
  bun run scripts/compile.ts [--target <bun-os-arch>] [--outfile <path>]

Defaults:
  --outfile ${DEFAULT_OUTFILE}

Version:
  Exact tag v{package.json} + clean tree → package version (e.g. 0.12.0)
  Otherwise → {version}-dev.<shortsha>[.dirty]

Examples:
  bun run build:compile
  bun run build:compile -- --target bun-linux-x64
  bun run build:compile -- --outfile dist/praana-macos --target bun-darwin-arm64
`);
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8")) as {
    version?: string;
  };
  return pkg.version?.trim() || "0.0.0";
}

/** Pure version formatter — exact release tag + clean tree → package version. */
export function formatCompileVersion(input: {
  packageVersion: string;
  exactTag: string | null;
  shortSha: string;
  dirty?: boolean;
}): string {
  const base = input.packageVersion.trim() || "0.0.0";
  const expectedTag = `v${base}`;
  if (input.exactTag === expectedTag && !input.dirty) {
    return base;
  }
  const sha = input.shortSha.trim() || "unknown";
  const dirty = input.dirty ? ".dirty" : "";
  return `${base}-dev.${sha}${dirty}`;
}

async function gitOutput(args: string[]): Promise<{
  ok: boolean;
  stdout: string;
}> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: resolve("."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout: stdout.trim() };
}

export async function resolveCompileVersion(
  packageVersion: string,
): Promise<string> {
  const [exact, sha, porcelain] = await Promise.all([
    gitOutput(["describe", "--exact-match", "--tags", "HEAD"]),
    gitOutput(["rev-parse", "--short=7", "HEAD"]),
    gitOutput(["status", "--porcelain"]),
  ]);

  return formatCompileVersion({
    packageVersion,
    exactTag: exact.ok ? exact.stdout : null,
    shortSha: sha.ok ? sha.stdout : "unknown",
    dirty: porcelain.ok && porcelain.stdout.length > 0,
  });
}

async function main(): Promise<void> {
  const { target, outfile, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }

  const version = await resolveCompileVersion(readPackageVersion());
  const outPath = resolve(outfile);
  mkdirSync(dirname(outPath), { recursive: true });

  console.log(
    `Compiling praana v${version} → ${outfile}${target ? ` (target=${target})` : ""}…`,
  );

  const result = await Bun.build({
    entrypoints: [resolve("src/main.ts")],
    target: "bun",
    // Match local `bun` runs: Solid transform + package "bun" export conditions
    // (@opentui/solid resolves to index.bun.js under this condition).
    conditions: ["bun"],
    tsconfig: resolve("tsconfig.json"),
    plugins: [solidPlugin],
    minify: true,
    sourcemap: "none",
    define: {
      PRAANA_BUILD_VERSION: JSON.stringify(version),
    },
    compile: {
      ...(target ? { target: target as Bun.Build.CompileTarget } : {}),
      outfile: outPath,
      // Critical: compiled binaries must not apply cwd bunfig.toml preloads.
      autoloadBunfig: false,
      autoloadDotenv: false,
      // Keep package/tsconfig resolution for workspace-relative imports if needed.
      autoloadTsconfig: true,
      autoloadPackageJson: true,
    },
  });

  if (!result.success) {
    console.error("Compile failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  console.log(`Wrote ${outfile}`);

  // Smoke: only when building for the host (no cross-compile target).
  if (!target) {
    const proc = Bun.spawn([outPath, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: resolve("."), // must work even with repo bunfig.toml present
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const expected = `PRAANA v${version}`;
    if (exitCode !== 0 || !stdout.includes(expected)) {
      console.error("Smoke test failed (praana --version from repo cwd):");
      if (stdout.trim()) console.error(stdout);
      if (stderr.trim()) console.error(stderr);
      console.error(`Expected stdout to include: ${expected}`);
      process.exit(1);
    }
    console.log(`Smoke OK: ${expected} (repo bunfig.toml present)`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
