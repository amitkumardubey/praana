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
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";

const require = createRequire(import.meta.url);
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

/** Flatten Bun.build AggregateError chains for actionable CI logs. */
export function formatBuildError(err: unknown): string {
  if (err instanceof AggregateError) {
    const nested = err.errors
      .map((nestedErr) => formatBuildError(nestedErr))
      .filter((line) => line.length > 0);
    if (nested.length > 0) {
      return nested.join("\n");
    }
  }
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
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

type FffBinCoords = { os: string; arch: string; libc?: string };

/** Map a bun compile target (or host) to the @ff-labs/fff-bin-* package name. */
export function resolveFffBinPackage(target?: string): string {
  const { os, arch, libc } = resolveFffBinCoords(target);
  if (os === "linux") {
    return `@ff-labs/fff-bin-linux-${arch}-${libc ?? "gnu"}`;
  }
  if (os === "darwin") {
    return `@ff-labs/fff-bin-darwin-${arch}`;
  }
  if (os === "win32") {
    return `@ff-labs/fff-bin-win32-${arch}`;
  }
  throw new Error(`Unsupported fff platform for compile target: ${target ?? "host"}`);
}

function resolveFffBinCoords(target?: string): FffBinCoords {
  if (!target) {
    return {
      os: process.platform,
      arch: process.arch,
      libc: process.platform === "linux" ? "gnu" : undefined,
    };
  }

  const match = /^bun-(darwin|linux|windows)-(x64|arm64)$/.exec(target);
  if (!match) {
    throw new Error(`Cannot resolve fff bin package for compile target: ${target}`);
  }

  const os = match[1] === "windows" ? "win32" : match[1]!;
  return { os, arch: match[2]!, libc: os === "linux" ? "gnu" : undefined };
}

/** Fail fast when the platform fff native package is missing at compile time. */
export function assertFffBinPackage(target?: string): void {
  const pkg = resolveFffBinPackage(target);
  try {
    require.resolve(`${pkg}/package.json`);
  } catch {
    throw new Error(
      `Missing ${pkg}. Standalone search_code requires the platform fff-bin package when compiling. Run bun install.`,
    );
  }
}

function buildDefines(version: string, target?: string): Record<string, string> {
  const defines: Record<string, string> = {
    PRAANA_BUILD_VERSION: JSON.stringify(version),
  };
  const { os, libc } = resolveFffBinCoords(target);
  if (os === "linux" && libc) {
    defines.FFF_LIBC = JSON.stringify(libc);
  }
  return defines;
}

async function smokeCompiledBinary(outPath: string, version: string): Promise<void> {
  const smokeCwd = "/tmp";

  const versionProc = Bun.spawn([outPath, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: smokeCwd,
  });
  const [versionStdout, versionStderr, versionCode] = await Promise.all([
    new Response(versionProc.stdout).text(),
    new Response(versionProc.stderr).text(),
    versionProc.exited,
  ]);
  const expected = `PRAANA v${version}`;
  if (versionCode !== 0 || !versionStdout.includes(expected)) {
    console.error("Smoke test failed (praana --version from /tmp):");
    if (versionStdout.trim()) console.error(versionStdout);
    if (versionStderr.trim()) console.error(versionStderr);
    console.error(`Expected stdout to include: ${expected}`);
    process.exit(1);
  }
  console.log(`Smoke OK: ${expected} (cwd=/tmp)`);

  const doctorProc = Bun.spawn([outPath, "doctor"], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: smokeCwd,
  });
  const [doctorStdout, doctorStderr, doctorCode] = await Promise.all([
    new Response(doctorProc.stdout).text(),
    new Response(doctorProc.stderr).text(),
    doctorProc.exited,
  ]);
  const doctorOut = `${doctorStdout}\n${doctorStderr}`;
  if (doctorCode !== 0 || !doctorOut.includes("search: fff available")) {
    console.error("Smoke test failed (praana doctor fff probe from /tmp):");
    if (doctorStdout.trim()) console.error(doctorStdout);
    if (doctorStderr.trim()) console.error(doctorStderr);
    console.error("Expected doctor to report embedded fff as available");
    process.exit(1);
  }
  console.log("Smoke OK: fff available via doctor (cwd=/tmp, no node_modules fallback)");
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

  assertFffBinPackage(target);
  const fffBin = resolveFffBinPackage(target);
  console.log(`fff embed: ${fffBin}`);

  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [resolve("src/main.ts")],
      target: "bun",
      // Match local `bun` runs: Solid transform + package "bun" export conditions
      // (@opentui/solid resolves to index.bun.js under this condition).
      conditions: ["bun"],
      tsconfig: resolve("tsconfig.json"),
      plugins: [solidPlugin],
      minify: true,
      sourcemap: "none",
      define: buildDefines(version, target),
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
  } catch (err) {
    console.error(
      `Bun.build threw while compiling${target ? ` target=${target}` : ""}:`,
    );
    console.error(formatBuildError(err));
    process.exit(1);
  }

  if (!result.success) {
    console.error("Compile failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  console.log(`Wrote ${outfile}`);

  // Smoke on native host builds only (cross-target binaries run on matching CI runners).
  if (!target) {
    await smokeCompiledBinary(outPath, version);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
