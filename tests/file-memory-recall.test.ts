import { afterEach, expect, spyOn, test } from "bun:test";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileMemoryStore } from "../src/file-memory/store.js";
import { memoryDirectories, projectKey, type MemoryScope } from "../src/file-memory/paths.js";
import { searchTokens, serializeMemory, type Memory } from "../src/file-memory/format.js";
import * as format from "../src/file-memory/format.js";
import { rankMemories } from "../src/file-memory/recall.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
async function setup() {
  const home = realpathSync(await fs.mkdtemp(join(tmpdir(), "recall-"))); homes.push(home);
  const cwd = join(home, "current");
  const options = { home, cwd, findRoot: (cwd: string) => cwd, now: () => new Date("2026-05-01T00:00:00Z") };
  const dirs = memoryDirectories(home, projectKey(cwd, options.findRoot));
  async function put(name: string, extra: Partial<Memory> = {}, scope: MemoryScope = "global") {
    await fs.mkdir(dirs[scope], { recursive: true });
    await fs.writeFile(join(dirs[scope], `${name}.md`), serializeMemory({ name, description: "Some details", type: "user", body: "A complete body", updated: "2026-05-01", ...extra }));
  }
  return { home, options, dirs, put, store: createFileMemoryStore(options) };
}
/** Replace a scope directory with a symlink to a sibling copy, so its scan fails at the
 * directory level (a per-file read error is only ever counted as skipped). */
async function unsafeScope(dirs: ReturnType<typeof memoryDirectories>, scope: MemoryScope) {
  const saved = `${dirs[scope]}-saved`;
  await fs.rename(dirs[scope], saved);
  await fs.symlink(saved, dirs[scope]);
  return saved;
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

for (const lookup of ["read", "recall"] as const) {
  test.each([
    ["project", "unsafe"], ["global", "unsafe"], ["project", "unresolved"],
  ] as const)(`${lookup} requires an explicit scope after a %s lookup fails (%s)`, async (badScope, failure) => {
    const { store, options, dirs, home } = await setup();
    const memory = { name: "shared", type: "user" as const, description: "Scope-specific preference" };
    for (const scope of ["global", "project"] as const) {
      expect((await store.write({ ...memory, scope, body: `Searchable ${scope} preference` })).ok).toBe(true);
    }
    expect(await store[lookup]({ name: "shared" })).toMatchObject({ ok: true, memory: { scope: "project" } });
    let cwd = options.cwd;
    if (failure === "unsafe") await unsafeScope(dirs, badScope);
    else if (failure === "unresolved") {
      cwd = join(home, "loop");
      await fs.symlink(cwd, cwd);
    }
    const probes: string[] = [];
    const seam = new Proxy(fs, { get(target, key) {
      if (key !== "lstat") return Reflect.get(target, key);
      return async (...args: Parameters<typeof fs.lstat>) => {
        probes.push(String(args[0]));
        return fs.lstat(...args);
      };
    } });
    const failing = createFileMemoryStore({ ...options, cwd, fs: seam });
    const reason = failure === "unsafe" ? dirs[badScope] : "cannot resolve project root: ELOOP";
    const warnings = [{ scope: badScope, reason: expect.stringContaining(reason) }];
    if (badScope === "project") {
      // Project has precedence, so a failed project scan blocks an unscoped answer.
      expect(await failing[lookup]({ name: "shared" })).toMatchObject({ ok: false, error: expect.stringMatching(/explicit scope/i), skippedScopes: warnings });
    } else {
      // The project copy is authoritative, so a failed global scan only warns.
      expect(await failing[lookup]({ name: "shared" })).toMatchObject({ ok: true, memory: { scope: "project", body: "Searchable project preference" }, skippedScopes: warnings });
    }
    const goodScope = badScope === "project" ? "global" : "project";
    expect(await failing[lookup]({ name: "shared", scope: goodScope })).toMatchObject({ ok: true, memory: { scope: goodScope, body: `Searchable ${goodScope} preference` } });
    expect(await failing[lookup]({ name: "shared", scope: badScope })).toMatchObject({ ok: false, error: expect.stringContaining(reason) });
    expect(await failing.recall({ query: "Searchable" })).toMatchObject({ ok: true, matches: [{ name: "shared", scope: goodScope }], skippedScopes: warnings });
    // The scan must reach the failing scope; any lstat at all would satisfy a bare counter.
    if (failure === "unresolved") expect(probes.filter((path) => path.startsWith(dirs.project))).toEqual([]);
    else expect(probes).toContain(dirs[badScope]);
    expect(await fs.exists(join(dirs[goodScope], "shared.md"))).toBe(true);
  });
}

for (const lookup of ["read", "recall"] as const) {
  test(`${lookup} returns a project hit even when the global scan failed`, async () => {
    const { options, dirs, put } = await setup();
    await put("shared", { body: "global copy" }); await put("shared", { body: "project copy" }, "project");
    await unsafeScope(dirs, "global");
    const failing = createFileMemoryStore(options);
    expect(await failing[lookup]({ name: "shared" })).toEqual({
      ok: true,
      memory: expect.objectContaining({ name: "shared", scope: "project", body: "project copy" }),
      skippedScopes: [{ scope: "global", reason: expect.stringContaining(dirs.global) }],
    });
  });

  test(`${lookup} refuses an unscoped lookup when the project scan failed, with or without a global copy`, async () => {
    const { options, dirs, put } = await setup();
    await put("shared", { body: "project copy" }, "project");
    await unsafeScope(dirs, "project");
    const failing = createFileMemoryStore(options);
    const warnings = [{ scope: "project", reason: expect.stringContaining(dirs.project) }];
    // No global copy at all: the project might still hold the name, so refuse.
    expect(await failing[lookup]({ name: "shared" })).toMatchObject({ ok: false, error: expect.stringMatching(/explicit scope/i), skippedScopes: warnings });
    await put("shared", { body: "global copy" });
    expect(await failing[lookup]({ name: "shared" })).toMatchObject({ ok: false, error: expect.stringMatching(/explicit scope/i), skippedScopes: warnings });
    expect(await failing[lookup]({ name: "shared", scope: "global" })).toMatchObject({ ok: true, memory: { scope: "global", body: "global copy" } });
  });

  test(`${lookup} falls through to the global result after a clean project miss`, async () => {
    const { options, dirs, put, store } = await setup();
    await put("shared", { body: "global copy" });
    // Hit, miss and failure all come from global unchanged, with no warning.
    expect(await store[lookup]({ name: "shared" })).toEqual(await store[lookup]({ name: "shared", scope: "global" }));
    expect(await store[lookup]({ name: "absent" })).toEqual(await store[lookup]({ name: "absent", scope: "global" }));
    await unsafeScope(dirs, "global");
    const failing = createFileMemoryStore(options);
    const unscoped = await failing[lookup]({ name: "shared" });
    const explicit = await failing[lookup]({ name: "shared", scope: "global" });
    if (unscoped.ok) throw new Error("Expected the global scan failure to surface");
    expect(unscoped.error).not.toMatch(/explicit scope/i);
    expect(unscoped).toEqual(explicit);
    expect(unscoped).toMatchObject({ ok: false, error: expect.stringContaining(dirs.global), skippedScopes: [{ scope: "global" }] });
  });
}

test("by-name operations report every scope failure instead of unusable explicit-scope advice", async () => {
  const { options, dirs, put } = await setup();
  await put("shared", { body: "global copy" }); await put("shared", { body: "project copy" }, "project");
  const saved = { project: await unsafeScope(dirs, "project"), global: await unsafeScope(dirs, "global") };
  const store = createFileMemoryStore(options);
  const results = [await store.read({ name: "shared" }), await store.recall({ name: "shared" }), await store.remove({ name: "shared" })];
  for (const result of results) {
    if (result.ok) throw new Error("Expected every scope failure to be reported");
    expect(result.error).not.toMatch(/explicit scope/i);
    expect(result.error).toContain(`project: Unsafe memory directory: ${dirs.project}`);
    expect(result.error).toContain(`global: Unsafe memory directory: ${dirs.global}`);
    expect(result.skippedScopes?.map(({ scope }) => scope)).toEqual(["project", "global"]);
  }
  // read, recall and remove share one message construction, so they cannot drift.
  expect(results[1]).toEqual(results[0]);
  expect(results[2]).toEqual(results[0]);
  for (const scope of ["project", "global"] as const) expect(await fs.exists(join(saved[scope], "shared.md"))).toBe(true);
});

test("unscoped lookups scan project first, so only its failed scan refuses", async () => {
  const { options, dirs, put } = await setup();
  await put("shared", { body: "project copy" }, "project");
  await put("shared", { body: "global copy" });
  const order: string[] = [];
  const seam = new Proxy(fs, { get(target, key) {
    if (key !== "lstat") return Reflect.get(target, key);
    return async (...args: Parameters<typeof fs.lstat>) => { order.push(String(args[0])); return fs.lstat(...args); };
  } });
  const store = createFileMemoryStore({ ...options, fs: seam });
  expect(await store.read({ name: "shared" })).toMatchObject({ ok: true, memory: { scope: "project" } });
  const firstScan = (scope: "project" | "global") => order.findIndex((path) => path.startsWith(dirs[scope]));
  expect(firstScan("project")).toBeGreaterThanOrEqual(0);
  expect(firstScan("project")).toBeLessThan(firstScan("global"));

  // A failed leading scan could still hold the answer, so an unscoped lookup refuses.
  const leading = await setup();
  await leading.put("shared", { body: "project copy" }, "project");
  await leading.put("shared", { body: "global copy" });
  await unsafeScope(leading.dirs, "project");
  const leadingStore = createFileMemoryStore(leading.options);
  expect(await leadingStore.read({ name: "shared" })).toMatchObject({ ok: false, error: expect.stringMatching(/explicit scope/i), skippedScopes: [{ scope: "project" }] });
  expect(await leadingStore.read({ name: "shared", scope: "global" })).toMatchObject({ ok: true, memory: { scope: "global", body: "global copy" } });

  // A failed trailing scan cannot outrank the project scope, so it only warns.
  const trailing = await setup();
  await trailing.put("shared", { body: "project copy" }, "project");
  await trailing.put("shared", { body: "global copy" });
  await unsafeScope(trailing.dirs, "global");
  const trailingStore = createFileMemoryStore(trailing.options);
  expect(await trailingStore.read({ name: "shared" })).toMatchObject({ ok: true, memory: { scope: "project" }, skippedScopes: [{ scope: "global" }] });
  // A removal must rule out every scope, so the same trailing failure refuses it.
  expect(await trailingStore.remove({ name: "shared" })).toMatchObject({ ok: false, error: expect.stringMatching(/explicit scope/i), skippedScopes: [{ scope: "global" }] });
  expect(await fs.exists(join(trailing.dirs.project, "shared.md"))).toBe(true);
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

test("recall cleans controls without Markdown escaping, skips invalid files and orphan temps", async () => {
  const { store, put, dirs } = await setup();
  await put("safe", { description: "- [forged](x)\n# instruction", body: "> search\n- [do-this](x) `cmd`\u0000" + "😀".repeat(400) });
  await fs.writeFile(join(dirs.global, ".safe.md.tmp-orphan"), "search");
  await fs.writeFile(join(dirs.global, "bad.md"), "search");
  await fs.symlink(join(dirs.global, "safe.md"), join(dirs.global, "linked.md"));
  const result = await store.recall({ query: "search" });
  if (!result.ok || !("matches" in result)) throw new Error("Expected matches");
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]!.description).toBe("- [forged](x) # instruction");
  expect(result.matches[0]!.snippet).toStartWith("> search - [do-this](x)");
  expect(result.matches[0]!.snippet).not.toContain("\n");
  expect(result.matches[0]!.snippet).not.toContain("\u0000");
  expect(result.matches[0]!.snippet).toContain("`cmd`");
  expect(Array.from(result.matches[0]!.snippet).length).toBeLessThan(320);
});

test("recall round-trips paths and regexes while index escapes Markdown", async () => {
  const { store, put } = await setup();
  const text = String.raw`Use C:\Users\x and regex \d+ [pattern] ` + "`code`";
  await put("paths", { description: text, body: text });
  const result = await store.recall({ query: "regex" });
  if (!result.ok || !("matches" in result)) throw new Error("Expected matches");
  expect(result.matches[0]!.description).toBe(text);
  expect(result.matches[0]!.snippet).toBe(text);
  const index = await store.buildMemoryIndex();
  expect(index.text).toContain(String.raw`C:\\Users\\x`);
  expect(index.text).toContain("\\[pattern\\] \\`code\\`");
});

test("recall collapses whitespace and truncates cleanup by code points", async () => {
  const { store, put } = await setup();
  await put("clean", { description: "  clean\t\n\u0000  text  ", body: " clean\t\u0000\u2028 text " + "😀".repeat(400) });
  const result = await store.recall({ query: "clean" });
  if (!result.ok || !("matches" in result)) throw new Error("Expected matches");
  expect(result.matches[0]!.description).toBe("clean text");
  expect(result.matches[0]!.snippet).toStartWith("clean text 😀");
  expect(Array.from(result.matches[0]!.snippet).length).toBeLessThanOrEqual(300);
  expect(result.matches[0]!.snippet).not.toMatch(/[\u0000-\u001f\u2028\u2029]| {2}/);
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

test.each(["body", "description"] as const)("snippet centres a 300-code-point window on a late %s match", async (field) => {
  const { store, put } = await setup();
  await put("late", { [field]: "😀".repeat(899) + " needle " + "z".repeat(900) });
  const result = await store.recall({ query: "needle" });
  if (!result.ok || !("matches" in result)) throw new Error("Expected matches");
  const snippet = result.matches[0]!.snippet;
  expect(snippet).toContain("needle");
  expect(Array.from(snippet)).toHaveLength(300);
  expect(Array.from(snippet.slice(0, snippet.indexOf("needle"))).length).toBeGreaterThan(100);
  expect(Array.from(snippet.slice(0, snippet.indexOf("needle"))).length).toBeLessThan(160);
});

test("name-only matches use the body start; body matches take precedence over description", async () => {
  const { store, put } = await setup();
  await put("needle", { body: "start " + "x".repeat(400) });
  await put("both", { description: "needle description", body: "😀".repeat(900) + " needle body" });
  const result = await store.recall({ query: "needle" });
  if (!result.ok || !("matches" in result)) throw new Error("Expected matches");
  expect(result.matches.find((match) => match.name === "needle")!.snippet).toStartWith("start ");
  expect(result.matches.find((match) => match.name === "both")!.snippet).toContain("needle body");
});

test("a 64 KiB body matching only its last word is tokenized once, not once per preceding word", () => {
  const body = "word ".repeat(13106) + "needle";
  expect(Buffer.byteLength(body)).toBe(65536);
  const tokenize = spyOn(format, "searchTokens");
  try {
    const matches = rankMemories([{ name: "large", description: "details", body, type: "user", updated: "2026-05-01", scope: "global" }], "needle");
    expect(matches[0]!.snippet).toEndWith("needle");
    expect(Array.from(matches[0]!.snippet)).toHaveLength(300);
    expect(tokenize.mock.calls.filter(([text]) => text === body)).toHaveLength(1);
    // One query and three corpus fields; the snippet must not re-tokenize words.
    expect(tokenize).toHaveBeenCalledTimes(4);
  } finally { tokenize.mockRestore(); }
});

test("query tokenizes multiple words case-insensitively and supports Unicode", async () => {
  const { store, put } = await setup();
  await put("cafe", { body: "CAFÉ orbit" });
  const result = await store.recall({ query: "the café ORBIT" });
  if (!result.ok || !("matches" in result)) throw new Error("Expected matches");
  expect(result.matches.map((match) => match.name)).toEqual(["cafe"]);
});
