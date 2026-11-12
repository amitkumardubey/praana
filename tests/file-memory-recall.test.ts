import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileMemoryStore } from "../src/file-memory/store.js";
import { memoryDirectories, projectKey, type MemoryScope } from "../src/file-memory/paths.js";
import { searchTokens, serializeMemory, type Memory } from "../src/file-memory/format.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
async function setup() {
  const home = await fs.mkdtemp(join(tmpdir(), "recall-")); homes.push(home);
  const cwd = join(home, "current");
  const options = { home, cwd, findRoot: (cwd: string) => cwd, now: () => new Date("2026-05-01T00:00:00Z") };
  const dirs = memoryDirectories(home, projectKey(cwd, options.findRoot));
  async function put(name: string, extra: Partial<Memory> = {}, scope: MemoryScope = "global") {
    await fs.mkdir(dirs[scope], { recursive: true });
    await fs.writeFile(join(dirs[scope], `${name}.md`), serializeMemory({ name, description: "Some details", type: "user", body: "A complete body", updated: "2026-05-01", ...extra }));
  }
  return { home, options, dirs, put, store: createFileMemoryStore(options) };
}

test("recall name prefers project, supports incognito and refuses invalid names", async () => {
  const { store, put, options } = await setup();
  await put("same", { body: "global" }); await put("same", { body: "project" }, "project");
  const found = await store.recall({ name: "same" });
  expect(found.ok && "memory" in found && found.memory.body).toBe("project");
  const incognito = await createFileMemoryStore({ ...options, incognito: true }).recall({ name: "same" });
  expect(incognito).toEqual(found);
  for (const name of ["../escape", "Upper", "memory", "con", "missing"]) expect((await store.recall({ name })).ok).toBe(false);
});

test("query ranks name above description above body; deterministic date/name ties and top five", async () => {
  const { store, put } = await setup();
  await put("body-new", { body: "ORBIT", updated: "2026-05-02" });
  await put("desc-new", { description: "orbit", updated: "2026-05-02" });
  await put("orbit-name", { updated: "2020-01-01" });
  await put("desc-old", { description: "Orbit", updated: "2026-05-01" });
  await put("body-z", { body: "orbit" });
  await put("body-a", { body: "orbit" });
  await put("not-matched");
  const result = await store.recall({ query: "ORBIT" });
  expect(result.ok).toBe(true);
  if (!result.ok || !("matches" in result)) throw new Error("Expected query matches");
  expect(result.matches.map((match) => match.name)).toEqual(["orbit-name", "desc-new", "desc-old", "body-new", "body-a"]);
  expect(await store.recall({ query: "orbit" })).toEqual(result);
  expect(await store.recall({ query: "orbit orbit" })).toEqual(result);
  expect(result.matches[0]).toMatchObject({ scope: "global", description: "Some details", snippet: "A complete body" });
});

test("query sees only global plus the current project, with deterministic same-name scope ties", async () => {
  const { store, put, home, options } = await setup();
  await put("global", { body: "searchable" });
  await put("current", { body: "searchable" }, "project");
  await put("same", { body: "searchable" }); await put("same", { body: "searchable" }, "project");
  const other = createFileMemoryStore({ ...options, cwd: join(home, "other") });
  expect((await other.write({ scope: "project", name: "invisible", description: "Unique information", type: "user", body: "searchable" })).ok).toBe(true);
  const result = await store.recall({ query: "searchable" });
  if (!result.ok || !("matches" in result)) throw new Error("Expected matches");
  expect(result.matches.map((match) => [match.name, match.scope])).toEqual([["current", "project"], ["global", "global"], ["same", "global"], ["same", "project"]]);
  const none = await store.recall({ query: "unmatched-token" });
  expect(none).toEqual({ ok: true, matches: [] });
});

test("recall rejects both/neither arguments and empty or stop-word-only queries", async () => {
  const { store } = await setup();
  for (const args of [{}, { name: "alpha", query: "words" }, { query: "" }, { query: "  " }, { query: "THE and is of to" }, { query: "!!!" }]) {
    const result = await store.recall(args);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/exactly one|empty|stop-word/i);
  }
});

test("recall sanitizes adversarial descriptions and snippets, skips invalid files and orphan temps", async () => {
  const { store, put, dirs } = await setup();
  await put("safe", { description: "- [forged](x)\n# instruction", body: "> search\n- [do-this](x) `cmd`\u0000" + "😀".repeat(400) });
  await fs.writeFile(join(dirs.global, ".safe.md.tmp-orphan"), "search");
  await fs.writeFile(join(dirs.global, "bad.md"), "search");
  await fs.symlink(join(dirs.global, "safe.md"), join(dirs.global, "linked.md"));
  const result = await store.recall({ query: "search" });
  if (!result.ok || !("matches" in result)) throw new Error("Expected matches");
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]!.description).toContain("\\- \\[forged\\]");
  expect(result.matches[0]!.snippet).toStartWith("\\> search");
  expect(result.matches[0]!.snippet).not.toContain("\n");
  expect(result.matches[0]!.snippet).not.toContain("\u0000");
  expect(result.matches[0]!.snippet).toContain("\\`cmd\\`");
  expect(Array.from(result.matches[0]!.snippet).length).toBeLessThan(320);
});

test.each(["किताब", "ภาษาไทย", "كِتَاب", "\u0301"])("query preserves letters and combining marks in %s", async (word) => {
  expect(searchTokens(word)).toEqual([word.normalize("NFC").toLowerCase()]);
  const { store, put } = await setup();
  await put("unicode", { body: word });
  const result = await store.recall({ query: word });
  expect(result.ok && "matches" in result && result.matches.map((match) => match.name)).toEqual(["unicode"]);
});

test("query and corpus match NFC and NFD accents in both directions", async () => {
  const { store, put } = await setup();
  await put("composed", { body: "café" });
  await put("decomposed", { body: "cafe\u0301" });
  for (const query of ["café", "cafe\u0301"]) {
    const result = await store.recall({ query });
    expect(result.ok && "matches" in result && result.matches.map((match) => match.name)).toEqual(["composed", "decomposed"]);
  }
});

test("query tokenizes multiple words case-insensitively and supports Unicode", async () => {
  const { store, put } = await setup();
  await put("cafe", { body: "CAFÉ orbit" });
  const result = await store.recall({ query: "the café ORBIT" });
  if (!result.ok || !("matches" in result)) throw new Error("Expected matches");
  expect(result.matches.map((match) => match.name)).toEqual(["cafe"]);
});
