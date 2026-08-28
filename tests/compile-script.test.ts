import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "bun:test";
import { formatCompileVersion, formatBuildError } from "../scripts/compile.js";

describe("compile script", () => {
  const source = readFileSync(resolve("scripts/compile.ts"), "utf-8");

  it("uses the OpenTUI Solid bun-plugin for JSX transform", () => {
    expect(source).toContain('@opentui/solid/bun-plugin');
    expect(source).toContain("plugins: [solidPlugin]");
  });

  it("disables bunfig autoload so cwd OpenTUI preloads cannot break the binary", () => {
    expect(source).toContain("autoloadBunfig: false");
    expect(source).toContain("autoloadDotenv: false");
  });

  it("compiles from src/main.ts into dist/praana by default", () => {
    expect(source).toContain('entrypoints: [resolve("src/main.ts")]');
    expect(source).toContain('const DEFAULT_OUTFILE = "dist/praana"');
  });

  it("bakes resolved version via PRAANA_BUILD_VERSION define", () => {
    expect(source).toContain("PRAANA_BUILD_VERSION");
    expect(source).toContain("define:");
    expect(source).toContain("resolveCompileVersion");
  });

  it("logs a thrown Bun.build error instead of a bare Bundle failed", () => {
    expect(source).toContain("Bun.build threw while compiling");
    expect(source).toContain("formatBuildError");
  });

  it("is wired as build:compile in package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["build:compile"]).toBe("bun run scripts/compile.ts");
  });
});

describe("formatBuildError", () => {
  it("flattens AggregateError chains", () => {
    const err = new AggregateError(
      [new Error("missing win32 optional dep")],
      "Bundle failed",
    );
    expect(formatBuildError(err)).toContain("missing win32 optional dep");
  });
});

describe("formatCompileVersion", () => {
  it("uses the package version on an exact matching release tag with a clean tree", () => {
    expect(
      formatCompileVersion({
        packageVersion: "0.12.0",
        exactTag: "v0.12.0",
        shortSha: "abc1234",
        dirty: false,
      }),
    ).toBe("0.12.0");
  });

  it("appends -dev.<sha> when HEAD is not exactly the package release tag", () => {
    expect(
      formatCompileVersion({
        packageVersion: "0.12.0",
        exactTag: null,
        shortSha: "f49ed71",
      }),
    ).toBe("0.12.0-dev.f49ed71");
  });

  it("appends -dev.<sha> when the exact tag does not match package.json", () => {
    expect(
      formatCompileVersion({
        packageVersion: "0.12.0",
        exactTag: "v0.11.1",
        shortSha: "deadbee",
      }),
    ).toBe("0.12.0-dev.deadbee");
  });

  it("marks dirty working trees even on an exact release tag", () => {
    expect(
      formatCompileVersion({
        packageVersion: "0.12.0",
        exactTag: "v0.12.0",
        shortSha: "abc1234",
        dirty: true,
      }),
    ).toBe("0.12.0-dev.abc1234.dirty");
  });
});
