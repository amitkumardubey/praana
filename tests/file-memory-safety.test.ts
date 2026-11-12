import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createFileMemoryStore } from "../src/file-memory/store.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
async function homeDir() { const home = await fs.mkdtemp(join(tmpdir(), "safety-")); homes.push(home); return home; }
const entry = { scope: "global" as const, type: "user" as const, name: "alpha", description: "Distinct detail", body: "Old complete content" };
const make = (home: string, seam?: typeof fs) => createFileMemoryStore({ home, cwd: home, fs: seam, findRoot: (cwd) => cwd, now: () => new Date("2026-01-01T00:00:00Z") });

test("write errors at temp write, fsync and rename preserve complete old content and clean only own temp", async () => {
  const home = await homeDir();
  const store = make(home);
  expect((await store.write(entry)).ok).toBe(true);
  const dir = join(home, ".praana/memory");
  await fs.writeFile(join(dir, ".alpha.md.tmp-orphan"), "partial");
  for (const stage of ["write", "sync", "rename"]) {
    const touched: string[] = [];
    const seam = new Proxy(fs, { get(target, key) {
      const original = Reflect.get(target, key);
      if (typeof original !== "function") return original;
      if (key === "open") return async (path: string, ...args: unknown[]) => {
        touched.push(path);
        const handle = await (original as (...args: unknown[]) => Promise<fs.FileHandle>)(path, ...args);
        if (!path.includes(".tmp-")) return handle;
        return new Proxy(handle, { get(h, method) {
          if ((stage === "write" && method === "writeFile") || (stage === "sync" && method === "sync")) return async () => { throw new Error(`failure at ${stage}`); };
          const value = Reflect.get(h, method); return typeof value === "function" ? value.bind(h) : value;
        } });
      };
      return (...args: unknown[]) => { for (const arg of args.slice(0, key === "rename" ? 2 : 1)) if (typeof arg === "string") touched.push(arg); if (key === "rename" && stage === "rename") throw new Error("failure at rename"); return original(...args); };
    } }) as typeof fs;
    expect((await make(home, seam).write({ ...entry, body: "New complete content" })).ok).toBe(false);
    const read = await store.read({ scope: "global", name: entry.name });
    expect(read.ok && read.memory.body).toBe(entry.body);
    expect((await fs.readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([".alpha.md.tmp-orphan"]);
    expect(touched.every((path) => { const rel = relative(home, path); return !rel.startsWith("..") && !isAbsolute(rel); })).toBe(true);
  }
  expect((await store.list({})).entries).toHaveLength(1);
});

test("refuses a write when strict redaction throws", async () => {
  const home = await homeDir();
  const input = { ...entry };
  Object.defineProperty(input, "trap", { enumerable: true, get() { throw new Error("redaction failed"); } });
  const result = await make(home).write(input);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("Secret scan failed");
  expect((await make(home).list({})).entries).toHaveLength(0);
});

test("rejects symlinked directories and directories escaping home", async () => {
  const home = await homeDir(), outside = await homeDir();
  await fs.symlink(outside, join(home, ".praana"));
  const store = make(home);
  expect((await store.write(entry)).ok).toBe(false);
  expect((await store.list({})).ok).toBe(false);
  expect(await fs.readdir(outside)).toEqual([]);
});

test("list reports ages and stale boundary", async () => {
  const home = await homeDir();
  const dir = join(home, ".praana/memory");
  await fs.mkdir(dir, { recursive: true });
  const format = (name: string, updated: string) => `---\nname: ${name}\ndescription: note\ntype: user\nupdated: '${updated}'\n---\ntext`;
  await fs.writeFile(join(dir, "old.md"), format("old", "2025-10-02"));
  await fs.writeFile(join(dir, "fresh.md"), format("fresh", "2025-10-03"));
  const result = await make(home).list({ scope: "global" });
  expect(result.entries.map(({ name, age, stale }) => ({ name, age, stale }))).toEqual([{ name: "fresh", age: 90, stale: false }, { name: "old", age: 91, stale: true }]);
});
