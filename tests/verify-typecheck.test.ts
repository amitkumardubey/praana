import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkTypecheck,
  findTsconfigDir,
  parseTscOutput,
} from "../src/verify/typecheck.js";

describe("parseTscOutput", () => {
  it("extracts file, line, col, and message", () => {
    const errors = parseTscOutput(
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
    );
    expect(errors).toEqual([
      {
        file: "src/a.ts",
        line: 3,
        col: 7,
        message: "TS2322: Type 'string' is not assignable to type 'number'.",
      },
    ]);
  });
});

describe("findTsconfigDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-tsc-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(join(dir, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("walks up to the nearest tsconfig inside the session root", () => {
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    const file = join(dir, "src", "a.ts");
    writeFileSync(file, "export {};\n");
    expect(findTsconfigDir(file, dir)).toBe(dir);
  });

  it("returns null when no tsconfig exists under the session root", () => {
    const file = join(dir, "src", "a.ts");
    writeFileSync(file, "export {};\n");
    expect(findTsconfigDir(file, dir)).toBeNull();
  });
});

describe("checkTypecheck", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-tsc2-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips non-TS extensions", async () => {
    const result = await checkTypecheck(join(dir, "a.py"), dir, {
      runTypecheck: async () => {
        throw new Error("should not spawn");
      },
    });
    expect(result.skipped).toBe("unsupported");
  });

  it("skips when no tsconfig is found", async () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "export {};\n");
    const result = await checkTypecheck(file, dir, {
      runTypecheck: async () => {
        throw new Error("should not spawn");
      },
    });
    expect(result.skipped).toBe("no_tsconfig");
  });

  it("returns injected tsc errors", async () => {
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    const file = join(dir, "a.ts");
    writeFileSync(file, "export {};\n");
    const result = await checkTypecheck(file, dir, {
      runTypecheck: async () => ({
        stdout: "",
        stderr:
          "a.ts(1,1): error TS2304: Cannot find name 'missing'.\n",
        code: 2,
      }),
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("TS2304");
  });
});
