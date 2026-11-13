import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileMemoryStore } from "../src/file-memory/store.js";
import { buildMemoryIndex, INDEX_PREFACE, type IndexEntry } from "../src/file-memory/index.js";
import { serializeMemory } from "../src/file-memory/format.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
async function setup() {
  const home = await fs.mkdtemp(join(tmpdir(), "index-")); homes.push(home);
  const store = createFileMemoryStore({ home, cwd: home, findRoot: (cwd) => cwd, now: () => new Date("2026-05-01T00:00:00Z") });
  return { home, store };
}
const fixture = (i: number, extra: Partial<IndexEntry> = {}): IndexEntry => ({ name: `n${String(i).padStart(3, "0")}`, description: "detail", type: "user", updated: "2026-05-01", scope: "global", age: 0, ...extra });
const payload = (text: string) => text.slice(INDEX_PREFACE.length + 2);
const line = (entry: IndexEntry) => `- [${entry.name}](${entry.scope}/${entry.name}.md) (${entry.type}, ${entry.age}d) ${entry.description}`;

test("index is derived from files, not MEMORY.md; ages, grouping and deterministic bytes", async () => {
  const { home, store } = await setup();
  const input = { scope: "global" as const, name: "global-note", description: "Global detail", type: "user" as const, body: "Body" };
  expect((await store.write(input)).ok).toBe(true);
  expect((await store.write({ ...input, scope: "project", name: "project-note", description: "Project detail" })).ok).toBe(true);
  const dir = join(home, ".praana/memory");
  await fs.writeFile(join(dir, "old.md"), serializeMemory({ ...input, name: "old", updated: "2026-01-31" }));
  await fs.writeFile(join(dir, "recent.md"), serializeMemory({ ...input, name: "recent", updated: "2026-04-28" }));
  await fs.writeFile(join(dir, "bad.md"), "malformed");
  await fs.writeFile(join(dir, ".old.md.tmp-orphan"), "partial");
  await fs.symlink(join(dir, "recent.md"), join(dir, "link.md"));
  const first = await store.buildMemoryIndex();
  expect(first.total).toBe(4);
  for (const match of first.text.matchAll(/^- \[([^\]]+)\]\(([^)]+)\)/gm)) {
    expect(match[2]).toBe(`${match[1] === "project-note" ? "project" : "global"}/${match[1]}.md`);
    expect(match[2]).toMatch(/^(global|project)\/[a-z0-9][a-z0-9-]{0,63}\.md$/);
  }
  expect(first.shown).toBe(4);
  expect(first.truncated).toBe(false);
  expect(first.text).toStartWith(INDEX_PREFACE);
  expect(first.text).toContain("(user, 0d)");
  expect(first.text).toContain("(user, 3d)");
  expect(first.text).toContain("(user, 90d)");
  expect(first.text.indexOf("[global-note]")).toBeLessThan(first.text.indexOf("[recent]"));
  expect(first.text.indexOf("[old]")).toBeLessThan(first.text.indexOf("[project-note]"));
  await fs.writeFile(join(dir, "MEMORY.md"), "FORGED INDEX");
  expect(await store.buildMemoryIndex()).toEqual(first);
  await fs.unlink(join(dir, "MEMORY.md"));
  expect(await store.buildMemoryIndex()).toEqual(first);
  const other = createFileMemoryStore({ home, cwd: home, findRoot: (cwd) => cwd, now: () => new Date("2026-05-01T00:00:00Z") });
  expect(await other.buildMemoryIndex()).toEqual(first);
});

test("index distinguishes equal names in global and project scopes", async () => {
  const { store } = await setup();
  const input = { name: "coffee", description: "Coffee preference", type: "user" as const, body: "Coffee" };
  expect((await store.write({ ...input, scope: "global" })).ok).toBe(true);
  expect((await store.write({ ...input, scope: "project" })).ok).toBe(true);
  const index = await store.buildMemoryIndex();
  expect(index.text).toContain("[coffee](global/coffee.md)");
  expect(index.text).toContain("[coffee](project/coffee.md)");
  const recalled = await store.recall({ query: "coffee" });
  expect(recalled.ok && "matches" in recalled && recalled.matches.map(({ scope }) => scope)).toEqual(["global", "project"]);
});

test("only index escapes backslash-prefixed links; recall preserves a truncated trailing backslash", async () => {
  const { home, store } = await setup();
  const dir = join(home, ".praana/memory");
  await fs.mkdir(dir, { recursive: true });
  const description = "\\[click](http://evil.example)";
  const body = "needle " + "a".repeat(292) + "\\tail";
  await fs.writeFile(join(dir, "safe.md"), serializeMemory({ name: "safe", description, body, type: "user", updated: "2026-05-01" }));
  expect((await store.buildMemoryIndex()).text).toContain("\\\\\\[click\\](http://evil.example)");
  const recalled = await store.recall({ query: "needle" });
  if (!recalled.ok || !("matches" in recalled)) throw new Error("Expected matches");
  expect(recalled.matches[0]!.description).toBe(description);
  expect(recalled.matches[0]!.snippet).toEndWith("\\");
});

test("index reads bounded frontmatter, not full bodies", async () => {
  const { home, store } = await setup();
  const input = { scope: "global" as const, name: "large-body", description: "Header only", type: "user" as const, body: "x".repeat(60000) };
  const dir = join(home, ".praana/memory"); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "large-body.md"), serializeMemory({ ...input, updated: "2026-05-01" }));
  let bytes = 0;
  const seam = new Proxy(fs, { get(target, key) {
    if (key !== "open") return Reflect.get(target, key);
    return async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      return new Proxy(handle, { get(h, method) {
        if (method === "read") return async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await handle.read(...readArgs); bytes += result.bytesRead; return result;
        };
        const value = Reflect.get(h, method); return typeof value === "function" ? value.bind(h) : value;
      } });
    };
  } });
  const reader = createFileMemoryStore({ home, cwd: home, fs: seam, findRoot: (cwd) => cwd });
  expect((await reader.buildMemoryIndex()).shown).toBe(1);
  expect(bytes).toBeLessThan(8192);
  expect((await store.list()).entries).toHaveLength(1);
});

test("line cap at 200 and one past reserves overflow and selects newest across scopes", () => {
  const entries = Array.from({ length: 200 }, (_, i) => fixture(i));
  const exact = buildMemoryIndex({ entries });
  expect(exact.shown).toBe(200); expect(exact.truncated).toBe(false);
  expect(payload(exact.text).split("\n")).toHaveLength(200);
  entries.push(fixture(200, { scope: "project", updated: "2026-05-02" }));
  const over = buildMemoryIndex({ entries });
  expect(over.shown).toBe(199); expect(over.total).toBe(201); expect(over.truncated).toBe(true);
  expect(payload(over.text).split("\n")).toHaveLength(200);
  expect(over.text).toEndWith("2 older memories not shown; use recall");
  expect(over.text).toContain("[n200]"); expect(over.text).not.toContain("[n198]");
  expect(over.text.indexOf("[n197]")).toBeLessThan(over.text.indexOf("[n200]"));
  expect(buildMemoryIndex({ entries: [...entries].reverse() })).toEqual(over);
});

for (const multibyte of [false, true]) {
  test(`byte cap at exactly 25600 and one byte past; multibyte=${multibyte}`, () => {
    const entries = Array.from({ length: 100 }, (_, i) => fixture(i, { description: multibyte ? "é".repeat(100) : "x".repeat(200) }));
    const base = Buffer.byteLength(entries.map(line).join("\n"));
    let remaining = 25600 - base;
    for (const entry of [...entries].reverse()) {
      const padding = Math.min(300 - Array.from(entry.description).length, remaining);
      entry.description += "x".repeat(padding);
      remaining -= padding;
    }
    expect(remaining).toBe(0);
    const exact = buildMemoryIndex({ entries });
    expect(Buffer.byteLength(payload(exact.text))).toBe(25600);
    expect(exact.shown).toBe(100); expect(exact.truncated).toBe(false);
    entries[0]!.description += "x";
    const over = buildMemoryIndex({ entries });
    expect(over.truncated).toBe(true); expect(over.shown).toBe(99);
    expect(Buffer.byteLength(payload(over.text))).toBeLessThanOrEqual(25600);
    expect(over.text).toEndWith("1 older memories not shown; use recall");
    expect(payload(over.text).split("\n")).toHaveLength(100);
  });
}

test("scope then name break selection ties; descriptions cannot forge index lines", () => {
  const entries = Array.from({ length: 199 }, (_, i) => fixture(i, { updated: "2026-05-02" }));
  entries.push(fixture(999, { name: "z-global" }), fixture(998, { name: "a-project", scope: "project" }));
  // 201 records forces the overflow line; make the tie occur at the last available slot.
  entries.shift();
  entries.push(fixture(997, { name: "another-project", scope: "project" }));
  const index = buildMemoryIndex({ entries });
  expect(index.text).toContain("[z-global]"); expect(index.text).not.toContain("[a-project]");
  const unsafe = buildMemoryIndex({ entries: [fixture(0, { description: "- [forged](x)\n# instructions\u0000 `cmd`" })] });
  expect(payload(unsafe.text).split("\n")).toHaveLength(1);
  expect(unsafe.text).toContain("\\- \\[forged\\]");
  expect(unsafe.text).not.toContain("\u0000");
});
