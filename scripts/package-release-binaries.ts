#!/usr/bin/env bun
/**
 * Package compiled praana binaries into GitHub Release archives.
 *
 * Expects `dist/praana-{linux-x64,linux-arm64,darwin-arm64,darwin-x64}` from
 * `scripts/compile.ts` and matching `praana-natives-<target>.node` files in
 * `--native-dir` (default `dist/native`). Each archive contains:
 *   praana                 — compiled executable
 *   praana-natives.node    — Tree-sitter addon sidecar (same directory)
 *
 * Usage:
 *   bun run scripts/package-release-binaries.ts
 *   bun run scripts/package-release-binaries.ts -- --dist-dir dist --native-dir dist/native
 *   bun run scripts/package-release-binaries.ts -- --skip-native
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { SIDECAR_ADDON_FILENAME } from "../src/native/sidecar.js";

export const RELEASE_BINARY_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
  "darwin-x64",
] as const;

export type ReleaseBinaryTarget = (typeof RELEASE_BINARY_TARGETS)[number];

/** napi-rs triple whose `.node` is packed into each standalone archive. */
export const RELEASE_NATIVE_TRIPLE: Record<ReleaseBinaryTarget, string> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
};

const DEFAULT_DIST_DIR = "dist";
const DEFAULT_OUT_DIR = "dist/release";
const DEFAULT_NATIVE_DIR = "dist/native";

export function releaseBinaryFileName(target: ReleaseBinaryTarget): string {
  return `praana-${target}`;
}

export function releaseArchiveFileName(target: ReleaseBinaryTarget): string {
  return `praana-${target}.tar.gz`;
}

export function nativeSidecarDistName(target: ReleaseBinaryTarget): string {
  return `praana-natives-${target}.node`;
}

export function findNativeArtifact(
  artifactsDir: string,
  target: ReleaseBinaryTarget,
): string {
  const dir = join(artifactsDir, `bindings-${RELEASE_NATIVE_TRIPLE[target]}`);
  if (!existsSync(dir)) {
    throw new Error(`Missing native artifact directory for ${target}: ${dir}`);
  }
  const nodes = readdirSync(dir).filter((name) => name.endsWith(".node"));
  if (nodes.length !== 1) {
    throw new Error(
      `Expected exactly one .node in ${dir}, found ${nodes.length}: ${nodes.join(", ")}`,
    );
  }
  return join(dir, nodes[0]!);
}

/** GNU `sha256sum` format: hash, two spaces, filename, newline at EOF. */
export function formatSha256Sums(
  entries: ReadonlyArray<{ filename: string; hash: string }>,
): string {
  return `${entries.map((e) => `${e.hash}  ${e.filename}`).join("\n")}\n`;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function parseArgs(argv: string[]): {
  distDir: string;
  outDir: string;
  nativeDir: string;
  nativeArtifactsDir?: string;
  skipNative: boolean;
  help: boolean;
} {
  let distDir = DEFAULT_DIST_DIR;
  let outDir = DEFAULT_OUT_DIR;
  let nativeDir = DEFAULT_NATIVE_DIR;
  let nativeArtifactsDir: string | undefined;
  let skipNative = false;
  let allowMissing = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--skip-native") {
      skipNative = true;
      continue;
    }
    if (arg === "--allow-missing") {
      allowMissing = true;
      continue;
    }
    if (arg === "--dist-dir") {
      const next = argv[++i];
      if (!next) throw new Error("--dist-dir requires a path");
      distDir = next;
      continue;
    }
    if (arg.startsWith("--dist-dir=")) {
      distDir = arg.slice("--dist-dir=".length);
      continue;
    }
    if (arg === "--out-dir") {
      const next = argv[++i];
      if (!next) throw new Error("--out-dir requires a path");
      outDir = next;
      continue;
    }
    if (arg.startsWith("--out-dir=")) {
      outDir = arg.slice("--out-dir=".length);
      continue;
    }
    if (arg === "--native-dir") {
      const next = argv[++i];
      if (!next) throw new Error("--native-dir requires a path");
      nativeDir = next;
      continue;
    }
    if (arg.startsWith("--native-dir=")) {
      nativeDir = arg.slice("--native-dir=".length);
      continue;
    }
    if (arg === "--native-artifacts-dir") {
      const next = argv[++i];
      if (!next) throw new Error("--native-artifacts-dir requires a path");
      nativeArtifactsDir = next;
      continue;
    }
    if (arg.startsWith("--native-artifacts-dir=")) {
      nativeArtifactsDir = arg.slice("--native-artifacts-dir=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { distDir, outDir, nativeDir, nativeArtifactsDir, skipNative, allowMissing, help };
}

function printHelp(): void {
  console.log(`Package compiled praana binaries into GitHub Release archives.

Usage:
  bun run scripts/package-release-binaries.ts [options]

Defaults:
  --dist-dir ${DEFAULT_DIST_DIR}
  --out-dir ${DEFAULT_OUT_DIR}
  --native-dir ${DEFAULT_NATIVE_DIR}

Expects binaries named:
  ${RELEASE_BINARY_TARGETS.map((t) => releaseBinaryFileName(t)).join(", ")}

Expects native sidecars named:
  ${RELEASE_BINARY_TARGETS.map((t) => nativeSidecarDistName(t)).join(", ")}

Each archive contains \`${SIDECAR_ADDON_FILENAME}\` beside \`praana\` unless --skip-native.

Options:
  --allow-missing   Skip targets with no compiled binary (CI recovery)
`);
}

async function tarStaging(
  stagingDir: string,
  entries: string[],
  archivePath: string,
): Promise<void> {
  const proc = Bun.spawn(
    ["tar", "-C", stagingDir, "-czf", archivePath, ...entries],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `tar failed (exit ${exitCode}) writing ${archivePath}: ${stderr.trim()}`,
    );
  }
}

export async function packageReleaseBinaries(options: {
  distDir: string;
  outDir: string;
  nativeDir?: string;
  nativeArtifactsDir?: string;
  skipNative?: boolean;
  allowMissing?: boolean;
}): Promise<{ archives: string[]; checksumsPath: string }> {
  const distDir = resolve(options.distDir);
  const outDir = resolve(options.outDir);
  const skipNative = options.skipNative === true;
  const allowMissing = options.allowMissing === true;
  const nativeDir = resolve(options.nativeDir ?? DEFAULT_NATIVE_DIR);
  const nativeArtifactsDir = options.nativeArtifactsDir
    ? resolve(options.nativeArtifactsDir)
    : undefined;
  mkdirSync(outDir, { recursive: true });

  const archives: string[] = [];
  const checksumEntries: Array<{ filename: string; hash: string }> = [];

  for (const target of RELEASE_BINARY_TARGETS) {
    const binaryName = releaseBinaryFileName(target);
    const binaryPath = join(distDir, binaryName);
    if (!existsSync(binaryPath)) {
      if (allowMissing) {
        console.warn(`Skipping ${target}: missing compiled binary at ${binaryPath}`);
        continue;
      }
      throw new Error(`Missing compiled binary: ${binaryPath}`);
    }

    let nativePath: string | undefined;
    if (!skipNative) {
      nativePath = nativeArtifactsDir
        ? findNativeArtifact(nativeArtifactsDir, target)
        : join(nativeDir, nativeSidecarDistName(target));
      if (!existsSync(nativePath)) {
        throw new Error(
          `Missing native sidecar for ${target}: ${nativePath} (use --skip-native to pack binaries only)`,
        );
      }
    }

    const stagingDir = mkdtempSync(join(tmpdir(), `praana-release-${target}-`));
    try {
      const staged = join(stagingDir, "praana");
      copyFileSync(binaryPath, staged);
      chmodSync(staged, 0o755);

      const entries = ["praana"];
      if (nativePath) {
        copyFileSync(nativePath, join(stagingDir, SIDECAR_ADDON_FILENAME));
        entries.push(SIDECAR_ADDON_FILENAME);
      }

      const archiveName = releaseArchiveFileName(target);
      const archivePath = join(outDir, archiveName);
      await tarStaging(stagingDir, entries, archivePath);
      archives.push(archivePath);
      checksumEntries.push({
        filename: archiveName,
        hash: await sha256File(archivePath),
      });
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  const checksumsPath = join(outDir, "SHA256SUMS");
  if (archives.length === 0) {
    throw new Error("No release archives were produced");
  }
  writeFileSync(checksumsPath, formatSha256Sums(checksumEntries), "utf-8");
  return { archives, checksumsPath };
}

async function main(): Promise<void> {
  const { distDir, outDir, nativeDir, nativeArtifactsDir, skipNative, allowMissing, help } =
    parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }

  const result = await packageReleaseBinaries({
    distDir,
    outDir,
    nativeDir,
    nativeArtifactsDir,
    skipNative,
    allowMissing,
  });
  console.log(`Wrote ${result.archives.length} archives + ${basename(result.checksumsPath)}`);
  for (const archive of result.archives) {
    console.log(`  ${archive}`);
  }
  console.log(`  ${result.checksumsPath}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
