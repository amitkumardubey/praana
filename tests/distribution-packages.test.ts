import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  NATIVE_PLATFORM_PACKAGES,
  applyNativesOptionalDependencies,
  nativesOptionalDependencies,
} from "../scripts/prepare-natives-publish.js";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(path), "utf-8")) as Record<
    string,
    unknown
  >;
}

describe("distribution package manifests", () => {
  it("publishes @praana/natives lockstep with praana", () => {
    const root = readJson("package.json");
    const natives = readJson("packages/praana-natives/package.json");

    expect(root.name).toBe("praana");
    expect(natives.name).toBe("@praana/natives");
    expect(natives.private).toBeUndefined();
    expect(natives.version).toBe(root.version);
    expect(root.optionalDependencies).toEqual({
      "@praana/natives": root.version,
    });
    expect(
      (root.devDependencies as Record<string, string> | undefined)?.[
        "@praana/natives"
      ],
    ).toBeUndefined();
  });

  it("does not pack host .node files into the published natives root", () => {
    const natives = readJson("packages/praana-natives/package.json");
    const files = natives.files as string[];
    expect(files).toContain("index.js");
    expect(files).toContain("index.d.ts");
    expect(files).not.toContain("*.node");
    const napi = natives.napi as { targets: string[] };
    expect(napi.targets).toContain("aarch64-unknown-linux-gnu");
  });

  it("wires package:binaries and natives publish helpers", () => {
    const root = readJson("package.json");
    const scripts = root.scripts as Record<string, string>;
    expect(scripts["package:binaries"]).toBe(
      "bun run scripts/package-release-binaries.ts",
    );
    expect(scripts["natives:prepare-publish"]).toBe(
      "bun run scripts/prepare-natives-publish.ts",
    );
  });

  it("bumps natives version and the optionalDependency pin on each release", () => {
    const config = readJson("release-please-config.json");
    const pkg = (config.packages as Record<string, Record<string, unknown>>)["."];
    const extra = pkg?.["extra-files"] as Array<Record<string, unknown>>;
    expect(extra).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "json",
          path: "packages/praana-natives/package.json",
          jsonpath: "$.version",
        }),
        expect.objectContaining({
          type: "json",
          path: "package.json",
          jsonpath: "$.optionalDependencies['@praana/natives']",
        }),
      ]),
    );
  });
});

describe("prepare-natives-publish", () => {
  it("pins every napi platform leaf at the addon version", () => {
    const deps = nativesOptionalDependencies("0.12.0");
    expect(Object.keys(deps)).toEqual([...NATIVE_PLATFORM_PACKAGES]);
    for (const name of NATIVE_PLATFORM_PACKAGES) {
      expect(deps[name]).toBe("0.12.0");
    }
  });

  it("rewrites optionalDependencies without dropping other fields", () => {
    const next = applyNativesOptionalDependencies(
      { name: "@praana/natives", version: "0.12.0", license: "MIT" },
      "0.12.0",
    );
    expect(next.name).toBe("@praana/natives");
    expect(next.license).toBe("MIT");
    expect(next.optionalDependencies).toEqual(
      nativesOptionalDependencies("0.12.0"),
    );
  });
});
