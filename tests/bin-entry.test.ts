import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "bun:test";
import { main } from "../src/main.js";

describe("CLI binary entrypoint", () => {
  it("exports main for the bin wrapper to invoke after import", () => {
    expect(typeof main).toBe("function");
  });

  it("invokes exported main from the praana bin wrapper", () => {
    const binSource = readFileSync(resolve("bin/praana.js"), "utf-8");
    expect(binSource).toContain("await mod.main()");
  });

  it("preloads OpenTUI Solid before importing main (global install JSX)", () => {
    const binSource = readFileSync(resolve("bin/praana.js"), "utf-8");
    expect(binSource).toContain('@opentui/solid/preload');
    const preloadIdx = binSource.indexOf('@opentui/solid/preload');
    const mainIdx = binSource.indexOf("src/main.ts");
    expect(preloadIdx).toBeGreaterThanOrEqual(0);
    expect(mainIdx).toBeGreaterThan(preloadIdx);
  });

  it("does not ship a pran alias bin", () => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8")) as {
      bin?: Record<string, string>;
    };
    expect(pkg.bin).toEqual({ praana: "bin/praana.js" });
    expect(pkg.bin?.pran).toBeUndefined();
  });
});
