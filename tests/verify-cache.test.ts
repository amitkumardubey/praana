import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VerifyHashCache } from "../src/verify/cache.js";

describe("VerifyHashCache", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-vcache-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is not fresh until remembered", () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "export {};\n");
    const cache = new VerifyHashCache();
    expect(cache.isFresh(path)).toBe(false);
    cache.remember(path);
    expect(cache.isFresh(path)).toBe(true);
  });

  it("invalidates when file bytes change", () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "export {};\n");
    const cache = new VerifyHashCache();
    cache.remember(path);
    writeFileSync(path, "export const x = 1;\n");
    expect(cache.isFresh(path)).toBe(false);
  });

  it("treats a missing file as not fresh", () => {
    const cache = new VerifyHashCache();
    expect(cache.isFresh(join(dir, "missing.ts"))).toBe(false);
  });
});
