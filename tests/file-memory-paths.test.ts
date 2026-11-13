import { describe, expect, test } from "bun:test";
import { resolve, join, dirname } from "node:path";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { globalMemoryDirectory, memoryDirectories, projectKey } from "../src/file-memory/paths.js";
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

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("unresolvable EACCES root keeps global memory usable and reports the root from project operations", async () => {
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
      const warnings = [{ scope: "project", reason: expect.stringContaining(root) }];
      expect(await store.write({ scope: "global", name: "blocked", type: "user", description: "Root unavailable", body: "No guessing" })).toMatchObject({ ok: true, scope: "global" });
      expect(await store.list()).toMatchObject({ ok: true, entries: [{ name: "blocked", scope: "global" }], skippedScopes: warnings });
      expect(await store.recall({ query: "guessing" })).toMatchObject({ ok: true, matches: [{ name: "blocked", scope: "global" }], skippedScopes: warnings });
      expect(await store.buildMemoryIndex()).toMatchObject({ ok: true, total: 1, skippedScopes: warnings });
      expect(await store.refreshIndexFile("global")).toEqual({ ok: true });
      const results = [
        await store.write({ scope: "project", name: "blocked", type: "user", description: "Root unavailable", body: "No guessing" }),
        await store.read({ scope: "project", name: "blocked" }),
        await store.list({ scope: "project" }),
        await store.remove({ scope: "project", name: "blocked" }),
      ];
      for (const result of results) {
        expect(result).toMatchObject({ ok: false });
        expect((result as { error: string }).error).toContain("cannot resolve project root: EACCES");
        expect((result as { error: string }).error).toContain(root);
      }
      expect(await fs.exists(join(home, ".praana/memory/blocked.md"))).toBe(true);
      expect(await fs.exists(join(home, ".praana/projects"))).toBe(false);
    } finally {
      await fs.chmod(obstacle, 0o700);
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("unresolved project root leaves global memory usable and names the skipped project scope", async () => {
    const home = await fs.mkdtemp(join(tmpdir(), "paths-rootless-"));
    const loop = join(home, "loop");
    try {
      await fs.symlink(loop, loop);
      const make = () => createFileMemoryStore({ home, cwd: loop, findRoot: (cwd) => cwd, now: () => new Date("2026-05-01T00:00:00Z") });
      expect(() => make()).not.toThrow();
      const store = make();
      const warnings = [{ scope: "project", reason: expect.stringContaining("cannot resolve project root: ELOOP") }];
      const global = { scope: "global" as const, name: "portable", type: "user" as const, description: "Global survives a missing project root", body: "Global only" };
      expect(await store.write(global)).toMatchObject({ ok: true, scope: "global", created: true });
      expect(await store.read({ name: "portable" })).toMatchObject({ ok: false, error: expect.stringMatching(/explicit scope/i), skippedScopes: warnings });
      expect(await store.read({ name: "portable", scope: "global" })).toMatchObject({ ok: true, memory: { scope: "global" } });
      expect(await store.list()).toMatchObject({ ok: true, entries: [{ name: "portable", scope: "global" }], skippedScopes: warnings });
      expect(await store.list({ scope: "global" })).toMatchObject({ ok: true, entries: [{ name: "portable" }] });
      expect(await store.recall({ query: "Global" })).toMatchObject({ ok: true, matches: [{ name: "portable", scope: "global" }], skippedScopes: warnings });
      expect(await store.recall({ name: "portable" })).toMatchObject({ ok: false, error: expect.stringMatching(/explicit scope/i), skippedScopes: warnings });
      expect(await store.recall({ name: "portable", scope: "global" })).toMatchObject({ ok: true, memory: { scope: "global" } });
      expect(await store.buildMemoryIndex()).toMatchObject({ ok: true, total: 1, skippedScopes: warnings });
      expect(await store.refreshIndexFile("global")).toEqual({ ok: true });
      expect(await fs.readFile(join(home, ".praana/memory/MEMORY.md"), "utf8")).toContain("[portable](portable.md)");
      const projectResults = [
        await store.write({ ...global, scope: "project" }),
        await store.read({ name: "portable", scope: "project" }),
        await store.list({ scope: "project" }),
        await store.remove({ name: "portable", scope: "project" }),
        await store.refreshIndexFile("project"),
      ];
      for (const result of projectResults) {
        expect(result).toMatchObject({ ok: false });
        expect((result as { error: string }).error).toContain("cannot resolve project root: ELOOP");
      }
      expect(await store.remove({ name: "portable" })).toMatchObject({ ok: false, error: expect.stringMatching(/explicit scope/i) });
      expect(await fs.exists(join(home, ".praana/memory/portable.md"))).toBe(true);
      expect(await store.remove({ name: "portable", scope: "global" })).toEqual({ ok: true });
      expect(await fs.exists(join(home, ".praana/memory/portable.md"))).toBe(false);
      expect(await fs.exists(join(home, ".praana/projects"))).toBe(false);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
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

  test("both scopes derive from one resolved global directory", async () => {
    const home = "/home/example/./nested/..";
    const global = globalMemoryDirectory(home);
    expect(global).toBe("/home/example/.praana/memory");
    expect(memoryDirectories(home, "repo-123456").global).toBe(global);
    // The project path is built from that same directory, not from a second resolution of `home`.
    expect(memoryDirectories(home, "repo-123456").project).toBe(join(dirname(global), "projects", "repo-123456", "memory"));
    expect(memoryDirectories(home, "one").global).toBe(memoryDirectories(home, "two").global);
    const source = await fs.readFile(new URL("../src/file-memory/paths.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export function memoryDirectories"));
    expect(body.match(/globalMemoryDirectory\(/g) ?? []).toHaveLength(1);
    expect(body).not.toContain("resolve(");
  });
});
