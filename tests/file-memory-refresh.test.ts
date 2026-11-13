import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import * as memoryModule from "../src/file-memory/store.js";
import { buildMemoryIndex as renderIndex } from "../src/file-memory/index.js";

const { createFileMemoryStore } = memoryModule;
const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
async function setup() {
  const home = realpathSync(await fs.mkdtemp(join(tmpdir(), "refresh-"))); homes.push(home);
  const options = { home, cwd: home, findRoot: (cwd: string) => cwd, now: () => new Date("2026-05-01T00:00:00Z") };
  return { options, store: createFileMemoryStore(options), dir: join(home, ".praana/memory") };
}
const input = { scope: "global" as const, name: "coffee", description: "Morning preference", type: "user" as const, body: "Coffee" };
const scopeIndex = async (store: ReturnType<typeof createFileMemoryStore>, scope: "global" | "project") => {
  const { entries } = await store.list({ scope });
  return renderIndex({ entries, links: "relative" }).text;
};

test("each scope's MEMORY.md links resolve relative to its own directory", async () => {
  const { store, options } = await setup();
  expect((await store.write(input)).ok).toBe(true);
  expect((await store.write({ ...input, scope: "project", body: "Tea" })).ok).toBe(true);
  const [key] = await fs.readdir(join(options.home, ".praana/projects"));
  const dirs = { global: join(options.home, ".praana/memory"), project: join(options.home, ".praana/projects", key!, "memory") };
  for (const scope of ["global", "project"] as const) {
    const text = await fs.readFile(join(dirs[scope], "MEMORY.md"), "utf8");
    const links = [...text.matchAll(/^- \[([^\]]+)\]\(([^)]+)\)/gm)];
    expect(links).toHaveLength(1);
    for (const [, name, target] of links) {
      expect(target).toBe(`${name}.md`);
      expect(await fs.exists(resolve(dirs[scope], target!))).toBe(true);
    }
  }
  const prompt = await store.buildMemoryIndex();
  expect(prompt.text).toContain("[coffee](global/coffee.md)");
  expect(prompt.text).toContain("[coffee](project/coffee.md)");
});

for (const scope of ["global", "project"] as const) {
  test.each([false, true])(`incognito refresh leaves the ${scope} scope untouched (existing: %s)`, async (existing) => {
    const { store, options } = await setup();
    if (existing) expect((await store.write({ ...input, scope })).ok).toBe(true);
    const before = (await fs.readdir(options.home, { recursive: true })).sort();
    const index = before.find((path) => path.endsWith("MEMORY.md"));
    const text = index ? await fs.readFile(join(options.home, index), "utf8") : undefined;
    const stat = index ? await fs.stat(join(options.home, index)) : undefined;
    const calls: string[] = [];
    const seam = new Proxy(fs, { get(target, method) {
      const value = Reflect.get(target, method);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { calls.push(String(method)); return Reflect.apply(value, target, args); };
    } });
    const incognito = createFileMemoryStore({ ...options, incognito: true, fs: seam });
    const result = await incognito.refreshIndexFile(scope);
    expect((await fs.readdir(options.home, { recursive: true })).sort()).toEqual(before);
    if (index) {
      expect(await fs.readFile(join(options.home, index), "utf8")).toBe(text!);
      const after = await fs.stat(join(options.home, index));
      expect(after.ino).toBe(stat!.ino);
      expect(after.mtimeMs).toBe(stat!.mtimeMs);
    }
    expect(calls).toEqual([]);
    expect(result).toEqual({ ok: false, error: "Incognito mode prevents writes" });
    expect(result).toEqual(await incognito.write({ ...input, scope }));
  });
}

test("write and remove refresh only the affected scope; copy is derived and never read", async () => {
  const { store, dir, options } = await setup();
  expect((await store.write(input)).ok).toBe(true);
  expect(await fs.readFile(join(dir, "MEMORY.md"), "utf8")).toBe(await scopeIndex(store, "global"));
  const project = { ...input, scope: "project" as const, body: "Tea" };
  expect((await store.write(project)).ok).toBe(true);
  const projects = join(options.home, ".praana/projects");
  const [key] = await fs.readdir(projects);
  const projectIndex = join(projects, key!, "memory/MEMORY.md");
  const before = await fs.readFile(projectIndex, "utf8");
  expect((await store.remove({ scope: "global", name: "coffee" })).ok).toBe(true);
  expect(await fs.readFile(join(dir, "MEMORY.md"), "utf8")).not.toContain("[coffee]");
  expect(await fs.readFile(projectIndex, "utf8")).toBe(before);
  expect((await fs.stat(join(dir, "MEMORY.md"))).mode & 0o777).toBe(0o600);
  expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  await fs.writeFile(join(dir, "MEMORY.md"), "malicious instructions");
  const seam = new Proxy(fs, { get(target, method) {
    if (method === "readFile") return async (path: string, ...args: unknown[]) => {
      if (path.endsWith("MEMORY.md")) throw new Error("Index must never be read");
      return Reflect.apply(fs.readFile, fs, [path, ...args]);
    };
    if (method === "open") return async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith("MEMORY.md")) throw new Error("Index must never be opened for reading");
      return fs.open(...args);
    };
    return Reflect.get(target, method);
  } });
  const reader = createFileMemoryStore({ ...options, fs: seam });
  expect((await reader.refreshIndexFile("global")).ok).toBe(true);
  expect(await fs.readFile(join(dir, "MEMORY.md"), "utf8")).toBe(await scopeIndex(reader, "global"));
});

for (const stage of ["open", "sync", "rename"]) {
  test(`failed index ${stage} is atomic and never fails write or remove`, async () => {
    const { store, dir, options } = await setup();
    expect((await store.write(input)).ok).toBe(true);
    const index = join(dir, "MEMORY.md");
    const before = await fs.readFile(index, "utf8");
    let failures = 0;
    const seam = new Proxy(fs, { get(target, method) {
      if (method === "open") return async (...args: Parameters<typeof fs.open>) => {
        const indexTemp = String(args[0]).includes(".MEMORY.md.tmp-");
        if (indexTemp && stage === "open") { failures++; throw new Error("Index open failed"); }
        const handle = await fs.open(...args);
        if (!indexTemp || stage !== "sync") return handle;
        return new Proxy(handle, { get(h, key) {
          if (key === "sync") return async () => { failures++; throw new Error("Index sync failed"); };
          const value = Reflect.get(h, key); return typeof value === "function" ? value.bind(h) : value;
        } });
      };
      if (method === "rename") return async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]).endsWith("MEMORY.md") && stage === "rename") { failures++; throw new Error("Index rename failed"); }
        return fs.rename(...args);
      };
      return Reflect.get(target, method);
    } });
    const writer = createFileMemoryStore({ ...options, fs: seam });
    expect((await writer.write({ ...input, name: "tea", description: "Evening ritual" })).ok).toBe(true);
    expect(failures).toBe(1);
    expect(await fs.readFile(index, "utf8")).toBe(before);
    expect((await writer.remove({ scope: "global", name: "coffee" })).ok).toBe(true);
    expect(failures).toBe(2);
    expect((await writer.refreshIndexFile("global")).ok).toBe(false);
    expect(failures).toBe(3);
    expect(await fs.readFile(index, "utf8")).toBe(before);
    expect((await fs.readdir(dir)).filter((file) => file.includes(".tmp-"))).toEqual([]);
    expect((await store.read({ name: "tea" })).ok).toBe(true);
    expect((await store.read({ name: "coffee" })).ok).toBe(false);
    expect((await store.refreshIndexFile("global")).ok).toBe(true);
    expect(await fs.readFile(index, "utf8")).toContain("[tea]");
    expect(await fs.readFile(index, "utf8")).not.toContain("[coffee]");
  });
}

test("successful store operations touch only the injected home", async () => {
  const { options } = await setup();
  const touched: string[] = [];
  const seam = new Proxy(fs, { get(target, method) {
    const value = Reflect.get(target, method);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      for (const arg of args.slice(0, method === "rename" ? 2 : 1)) if (typeof arg === "string") touched.push(arg);
      return Reflect.apply(value, target, args);
    };
  } });
  const store = createFileMemoryStore({ ...options, fs: seam });
  expect((await store.write(input)).ok).toBe(true);
  expect((await store.write({ ...input, scope: "project" })).ok).toBe(true);
  expect((await store.read({ name: "coffee" })).ok).toBe(true);
  expect((await store.list()).ok).toBe(true);
  expect((await store.recall({ name: "coffee" })).ok).toBe(true);
  expect((await store.recall({ query: "coffee" })).ok).toBe(true);
  expect((await store.buildMemoryIndex()).total).toBe(2);
  expect((await store.remove({ scope: "project", name: "coffee" })).ok).toBe(true);
  expect((await store.remove({ name: "coffee" })).ok).toBe(true);
  expect(touched.length).toBeGreaterThan(30);
  for (const path of touched) {
    const rel = relative(options.home, path);
    expect(!rel.startsWith("..") && !isAbsolute(rel)).toBe(true);
  }
});

test("file-memory remains production-inert and independent of the old memory/compiler modules", async () => {
  const files = await fs.readdir("src", { recursive: true });
  for (const file of files.filter((path) => path.endsWith(".ts"))) {
    const text = await fs.readFile(join("src", file), "utf8");
    if (file.startsWith("file-memory/")) expect(text).not.toMatch(/from\s*["'](?:\.\.\/)+(?:memory(?:\/|\.js)|context-engine|compiler\.js)/);
    else expect(text).not.toMatch(/(?:from\s*|import\s*\()\s*["'][^"']*file-memory/);
  }
});

test("policy identifies durable observations and excludes transient or derivable state", () => {
  const policy = memoryModule.MEMORY_POLICY;
  expect(typeof policy).toBe("string");
  for (const term of ["correction", "non-obvious", "preference", "external", "status", "next step", "code", "git history", "AGENTS.md", "per-conversation"]) expect(policy).toContain(term);
});
