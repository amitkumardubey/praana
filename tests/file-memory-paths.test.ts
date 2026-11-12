import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
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

  test("constructs directories below the injected home", () => {
    expect(memoryDirectories("/home/example", "repo-123456")).toEqual({
      global: "/home/example/.praana/memory",
      project: "/home/example/.praana/projects/repo-123456/memory",
    });
  });
});
