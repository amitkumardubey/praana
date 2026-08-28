import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  RELEASE_BINARY_TARGETS,
  RELEASE_NATIVE_TRIPLE,
  findNativeArtifact,
  formatSha256Sums,
  nativeSidecarDistName,
  packageReleaseBinaries,
  releaseArchiveFileName,
  releaseBinaryFileName,
  sha256File,
} from "../scripts/package-release-binaries.js";
import { SIDECAR_ADDON_FILENAME } from "../src/native/sidecar.js";

describe("packageReleaseBinaries", () => {
  it("archives each target as praana and writes matching SHA256SUMS", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-package-binaries-"));
    const distDir = join(root, "dist");
    const outDir = join(root, "release");
    mkdirSync(distDir, { recursive: true });

    try {
      for (const target of RELEASE_BINARY_TARGETS) {
        const path = join(distDir, releaseBinaryFileName(target));
        writeFileSync(path, `fake-binary-${target}\n`, "utf-8");
        chmodSync(path, 0o755);
      }

      const result = await packageReleaseBinaries({
        distDir,
        outDir,
        skipNative: true,
      });
      expect(result.archives).toHaveLength(RELEASE_BINARY_TARGETS.length);
      expect(existsSync(result.checksumsPath)).toBe(true);

      const checksumLines: Array<{ filename: string; hash: string }> = [];
      for (const target of RELEASE_BINARY_TARGETS) {
        const archiveName = releaseArchiveFileName(target);
        const archivePath = join(outDir, archiveName);
        expect(existsSync(archivePath)).toBe(true);

        const listing = Bun.spawnSync(["tar", "-tzf", archivePath], {
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(listing.exitCode).toBe(0);
        const names = listing.stdout.toString("utf-8").trim().split("\n");
        expect(names).toContain("praana");

        checksumLines.push({
          filename: archiveName,
          hash: await sha256File(archivePath),
        });
      }

      expect(readFileSync(result.checksumsPath, "utf-8")).toBe(
        formatSha256Sums(checksumLines),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when a compiled binary is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-package-binaries-missing-"));
    try {
      await expect(
        packageReleaseBinaries({
          distDir: root,
          outDir: join(root, "out"),
          skipNative: true,
        }),
      ).rejects.toThrow(/Missing compiled binary/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips missing binaries when allowMissing is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-package-binaries-allow-missing-"));
    const distDir = join(root, "dist");
    const outDir = join(root, "out");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, releaseBinaryFileName("linux-x64")), "bin\n");

    try {
      const result = await packageReleaseBinaries({
        distDir,
        outDir,
        skipNative: true,
        allowMissing: true,
      });
      expect(result.archives).toHaveLength(1);
      expect(result.archives[0]).toContain("praana-linux-x64.tar.gz");
      expect(readFileSync(result.checksumsPath, "utf-8")).toContain(
        "praana-linux-x64.tar.gz",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when a native sidecar is missing unless skipNative", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-package-binaries-no-native-"));
    const distDir = join(root, "dist");
    mkdirSync(distDir, { recursive: true });
    try {
      for (const target of RELEASE_BINARY_TARGETS) {
        writeFileSync(
          join(distDir, releaseBinaryFileName(target)),
          `fake-binary-${target}\n`,
          "utf-8",
        );
      }
      await expect(
        packageReleaseBinaries({
          distDir,
          outDir: join(root, "out"),
          nativeDir: join(root, "native"),
        }),
      ).rejects.toThrow(/Missing native sidecar/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("packs praana-natives.node beside praana", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-package-binaries-sidecar-"));
    const distDir = join(root, "dist");
    const nativeDir = join(root, "native");
    const outDir = join(root, "release");
    mkdirSync(distDir, { recursive: true });
    mkdirSync(nativeDir, { recursive: true });

    try {
      for (const target of RELEASE_BINARY_TARGETS) {
        writeFileSync(
          join(distDir, releaseBinaryFileName(target)),
          `fake-binary-${target}\n`,
          "utf-8",
        );
        writeFileSync(
          join(nativeDir, nativeSidecarDistName(target)),
          `fake-native-${target}\n`,
          "utf-8",
        );
      }

      const result = await packageReleaseBinaries({ distDir, outDir, nativeDir });
      const listing = Bun.spawnSync(["tar", "-tzf", result.archives[0]!], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(listing.exitCode).toBe(0);
      const names = listing.stdout.toString("utf-8").trim().split("\n");
      expect(names).toContain("praana");
      expect(names).toContain(SIDECAR_ADDON_FILENAME);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("release native artifacts", () => {
  it("maps each release binary to a napi triple", () => {
    expect(Object.keys(RELEASE_NATIVE_TRIPLE).sort()).toEqual(
      [...RELEASE_BINARY_TARGETS].sort(),
    );
    expect(RELEASE_NATIVE_TRIPLE["linux-arm64"]).toBe(
      "aarch64-unknown-linux-gnu",
    );
  });

  it("finds a single .node under bindings-<triple>", () => {
    const root = mkdtempSync(join(tmpdir(), "praana-native-artifact-"));
    try {
      const dir = join(root, "bindings-x86_64-unknown-linux-gnu");
      mkdirSync(dir, { recursive: true });
      const nodePath = join(dir, "praana-natives.linux-x64-gnu.node");
      writeFileSync(nodePath, "fake\n");
      expect(findNativeArtifact(root, "linux-x64")).toBe(nodePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("packs from CI bindings-<triple> artifact layout", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-native-artifacts-dir-"));
    const distDir = join(root, "dist");
    const artifactsDir = join(root, "artifacts");
    mkdirSync(distDir, { recursive: true });
    try {
      for (const target of RELEASE_BINARY_TARGETS) {
        writeFileSync(join(distDir, releaseBinaryFileName(target)), "bin\n");
        const dir = join(
          artifactsDir,
          `bindings-${RELEASE_NATIVE_TRIPLE[target]}`,
        );
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `praana-natives.${target}.node`), "node\n");
      }
      const result = await packageReleaseBinaries({
        distDir,
        outDir: join(root, "out"),
        nativeArtifactsDir: artifactsDir,
      });
      const listing = Bun.spawnSync(["tar", "-tzf", result.archives[0]!], {
        stdout: "pipe",
      });
      expect(listing.stdout.toString("utf-8")).toContain(SIDECAR_ADDON_FILENAME);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("formatSha256Sums", () => {
  it("uses GNU sha256sum two-space format with a trailing newline", () => {
    expect(
      formatSha256Sums([
        { filename: "a.tar.gz", hash: "abc" },
        { filename: "b.tar.gz", hash: "def" },
      ]),
    ).toBe("abc  a.tar.gz\ndef  b.tar.gz\n");
  });
});
