import { describe, expect, test } from "bun:test";
import { resolve, join } from "node:path";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { memoryDirectories, projectKey } from "../src/file-memory/paths.js";

describe("file memory paths", () => {
  test("normalizes cwd before resolving the root and distinguishes equal basenames", () => {
    let seen = "";
    const findRoot = (cwd: string) => { seen = cwd; return resolve("/one/repo"); };
    const root = projectKey(".", findRoot);
    expect(seen).toBe(resolve("."));
    expect(projectKey("src", findRoot)).toBe(root);
    expect(root).toMatch(/^repo-[0-9a-f]{6}$/);
    expect(projectKey("/two/repo", (cwd) => cwd)).not.toBe(root);
    expect(projectKey("relative", (cwd) => cwd)).toBe(projectKey(resolve("relative"), (cwd) => cwd));
  });

  test("canonicalizes a symlinked cwd before choosing both slug and hash", async () => {
    const home = await fs.mkdtemp(join(tmpdir(), "paths-"));
    try {
      const real = join(home, "canonical"), alias = join(home, "alias");
      await fs.mkdir(real);
      await fs.symlink(real, alias);
      expect(projectKey(alias, (cwd) => cwd)).toBe(projectKey(real, (cwd) => cwd));
      expect(projectKey(join(alias, "..", "alias"), (cwd) => cwd)).toBe(projectKey(real, (cwd) => cwd));
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });

  test("constructs directories below the injected home", () => {
    expect(memoryDirectories("/home/example", "repo-123456")).toEqual({
      global: "/home/example/.praana/memory",
      project: "/home/example/.praana/projects/repo-123456/memory",
    });
  });
});
