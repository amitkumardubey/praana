import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, it, expect } from "bun:test";
import { main } from "../src/main.js";
import { createPackageTsxFilter } from "../bin/opentui-solid-runtime.js";

describe("CLI binary entrypoint", () => {
  it("exports main for the bin wrapper to invoke after import", () => {
    expect(typeof main).toBe("function");
  });

  it("invokes exported main from the praana bin wrapper", () => {
    const binSource = readFileSync(resolve("bin/praana.js"), "utf-8");
    expect(binSource).toContain("await mod.main()");
  });

  it("registers package-scoped Solid transform before importing main", () => {
    const binSource = readFileSync(resolve("bin/praana.js"), "utf-8");
    expect(binSource).toContain("registerPraanaSolidTransform");
    const registerIdx = binSource.indexOf("registerPraanaSolidTransform");
    const mainIdx = binSource.indexOf("src/main.ts");
    expect(registerIdx).toBeGreaterThanOrEqual(0);
    expect(mainIdx).toBeGreaterThan(registerIdx);
  });

  it("does not ship a pran alias bin", () => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8")) as {
      bin?: Record<string, string>;
    };
    expect(pkg.bin).toEqual({ praana: "bin/praana.js" });
    expect(pkg.bin?.pran).toBeUndefined();
  });
});

describe("createPackageTsxFilter", () => {
  it("matches package TSX even when installed under node_modules", () => {
    const root = "/root/.bun/install/global/node_modules/praana";
    const filter = createPackageTsxFilter(root);
    expect(filter.test(`${root}/src/ui/tui/run.tsx`)).toBe(true);
    expect(filter.test(`${root}/src/ui/tui/app.tsx`)).toBe(true);
  });

  it("matches a local checkout path", () => {
    const root = "/home/amit/projects/personal/praana";
    const filter = createPackageTsxFilter(root);
    expect(filter.test(`${root}/src/ui/tui/run.tsx`)).toBe(true);
  });

  it("does not match unrelated packages under node_modules", () => {
    const root = "/root/.bun/install/global/node_modules/praana";
    const filter = createPackageTsxFilter(root);
    expect(
      filter.test(
        "/root/.bun/install/global/node_modules/other-pkg/src/ui.tsx",
      ),
    ).toBe(false);
    expect(
      filter.test(join(root, "..", "solid-js", "src", "jsx.tsx")),
    ).toBe(false);
  });
});
