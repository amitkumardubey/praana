import { describe, expect, test } from "bun:test";
import { resolve, join } from "node:path";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { memoryDirectories, projectKey } from "../src/file-memory/paths.js";
import { createFileMemoryStore } from "../src/file-memory/store.js";

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

  test.each(["ENOENT", "ENOTDIR"])("project identity falls back without throwing on %s", async (code) => {
    const home = await fs.mkdtemp(join(tmpdir(), "paths-error-"));
    const obstacle = join(home, "obstacle");
    const root = join(obstacle, "repo");
    try {
      if (code === "ENOTDIR") await fs.writeFile(obstacle, "not a directory");
      // ENOENT leaves the root absent; ENOTDIR traverses a real file.
      let observed = "";
      try { await fs.realpath(root); } catch (error) { observed = (error as NodeJS.ErrnoException).code!; }
      expect(observed).toBe(code);
      expect(() => createFileMemoryStore({ home, cwd: root, findRoot: (cwd) => cwd })).not.toThrow();
      expect(projectKey(root, (cwd) => cwd)).toMatch(/^repo-[0-9a-f]{6}$/);
      expect(projectKey(root, (cwd) => cwd)).toBe(projectKey(join(root, "."), (cwd) => cwd));
      const store = createFileMemoryStore({ home, cwd: root, findRoot: (cwd) => cwd });
      expect((await store.write({ scope: "project", name: "fallback", type: "user", description: "Absent root", body: "Fallback identity" })).ok).toBe(true);
      expect((await store.read({ name: "fallback" })).ok).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("unresolvable EACCES root reports the path from every operation without throwing at construction", async () => {
    const home = await fs.mkdtemp(join(tmpdir(), "paths-denied-"));
    const obstacle = join(home, "denied"), root = join(obstacle, "repo");
    try {
      await fs.mkdir(root, { recursive: true });
      await fs.chmod(obstacle, 0);
      let observed = "";
      try { await fs.realpath(root); } catch (error) { observed = (error as NodeJS.ErrnoException).code!; }
      expect(observed).toBe("EACCES");
      expect(() => createFileMemoryStore({ home, cwd: root, findRoot: (cwd) => cwd })).not.toThrow();
      const store = createFileMemoryStore({ home, cwd: root, findRoot: (cwd) => cwd });
      const results = [
        await store.write({ scope: "global", name: "blocked", type: "user", description: "Root unavailable", body: "No guessing" }),
        await store.read({ scope: "global", name: "blocked" }),
        await store.remove({ name: "blocked" }),
        await store.recall({ name: "blocked" }),
        await store.recall({ query: "blocked" }),
        await store.list(),
        await store.list({ scope: "global" }),
        await store.buildMemoryIndex(),
        await store.refreshIndexFile("global"),
      ];
      for (const result of results) {
        expect(result).toMatchObject({ ok: false });
        expect((result as { error: string }).error).toContain("cannot resolve project root: EACCES");
        expect((result as { error: string }).error).toContain(root);
      }
      expect(await fs.exists(join(home, ".praana"))).toBe(false);
    } finally {
      await fs.chmod(obstacle, 0o700);
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("project identity refuses a real symlink loop instead of guessing", async () => {
    const home = await fs.mkdtemp(join(tmpdir(), "paths-loop-"));
    const root = join(home, "loop");
    try {
      await fs.symlink(root, root);
      expect(() => projectKey(root, (cwd) => cwd)).toThrow(/cannot resolve project root: ELOOP/);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });

  test("constructs directories below the injected home", () => {
    expect(memoryDirectories("/home/example", "repo-123456")).toEqual({
      global: "/home/example/.praana/memory",
      project: "/home/example/.praana/projects/repo-123456/memory",
    });
  });
});
