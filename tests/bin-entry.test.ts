import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";

describe("CLI binary entrypoint", () => {
  it("exports main for the bin wrapper to invoke after import", () => {
    expect(typeof main).toBe("function");
  });

  it("invokes exported main from the bin wrapper", () => {
    const binSource = readFileSync(resolve("bin/aria.js"), "utf-8");
    expect(binSource).toContain("await mod.main()");
  });
});
