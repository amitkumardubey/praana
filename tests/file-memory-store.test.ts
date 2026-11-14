import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileMemoryStore } from "../src/file-memory/store.js";
import { searchTokens } from "../src/file-memory/format.js";
import { memoryDirectories, projectKey } from "../src/file-memory/paths.js";

const scratch = tmpdir();
const homes: string[] = [];
async function setup(extra: Record<string, unknown> = {}) {
  const home = realpathSync(await fs.mkdtemp(join(scratch, "home-")));
  homes.push(home);
  const store = createFileMemoryStore({ home, cwd: home, findRoot: (cwd: string) => cwd, now: () => new Date("2026-05-01T00:00:00Z"), ...extra });
  return { home, store, dir: join(home, ".praana/memory") };
}
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
const input = { scope: "global" as const, type: "user" as const, name: "coffee", description: "Prefers coffee every morning", body: "Coffee is preferred." };

describe("file memory store", () => {
  test("writes atomically, detects duplicates, collisions and secrets", async () => {
    const { store, dir } = await setup();
    expect(await store.write(input)).toEqual({ ok: true, name: "coffee", scope: "global", created: true });
    expect((await store.write({ ...input, body: "Updated" })).ok).toBe(true);
    expect((await store.write({ ...input, name: "coffee2" })).ok).toBe(false);
    expect((await store.write({ ...input, name: "different", body: "sk-abcdefghijklmnopqrstuvwxyz123456" })).ok).toBe(false);
    await fs.writeFile(join(dir, "Foo.md"), "manual");
    expect((await store.write({ ...input, name: "foo", description: "unrelated description" })).ok).toBe(false);
  });
  test("removes skipped regular files but refuses symlinks and directories", async () => {
    const { store, dir } = await setup();
    await store.write(input);
    for (const [name, text] of [["bad", "broken"], ["huge", "x".repeat(65537)], ["edited", "---\nname: another\n---"]]) {
      await fs.writeFile(join(dir, `${name}.md`), text!);
      expect((await store.remove({ name: name! })).ok).toBe(true);
      expect(await fs.exists(join(dir, `${name}.md`))).toBe(false);
    }
    await fs.symlink(join(dir, "coffee.md"), join(dir, "link.md"));
    await fs.mkdir(join(dir, "folder.md"));
    expect((await store.remove({ name: "link" })).ok).toBe(false);
    expect((await store.remove({ name: "folder" })).ok).toBe(false);
    await store.write({ ...input, scope: "project" });
    await fs.writeFile(join(dir, "coffee.md"), "broken");
    expect((await store.remove({ name: "coffee" })).ok).toBe(false);
    expect((await store.remove({ name: "coffee", scope: "global" })).ok).toBe(true);
  });
  test.each([
    ["project", "symlink"], ["global", "symlink"], ["project", "directory"], ["global", "directory"],
  ] as const)("removes the real file when %s contains a stray %s", async (badScope, kind) => {
    const { home, store } = await setup();
    const dirs = memoryDirectories(home, projectKey(home, (cwd) => cwd));
    for (const scope of ["global", "project"] as const) expect((await store.write({ ...input, scope })).ok).toBe(true);
    const stray = join(dirs[badScope], "coffee.md");
    await fs.unlink(stray);
    if (kind === "symlink") await fs.symlink(join(home, "missing"), stray);
    else await fs.mkdir(stray);
    expect(await store.remove({ name: "coffee" })).toMatchObject({
      ok: true, skipped: [{ scope: badScope, reason: expect.stringMatching(/regular.*non-symlink/i) }],
    });
    const goodScope = badScope === "project" ? "global" : "project";
    expect(await fs.exists(join(dirs[goodScope], "coffee.md"))).toBe(false);
    const stat = await fs.lstat(stray);
    expect(kind === "symlink" ? stat.isSymbolicLink() : stat.isDirectory()).toBe(true);
    const onlyStray = await store.remove({ name: "coffee" });
    expect(onlyStray.ok).toBe(false);
    if (!onlyStray.ok) expect(onlyStray.error).toMatch(/regular.*non-symlink/);
  });
  test.each(["project", "global"] as const)("refuses unscoped removal when the %s scope scan failed and deletes nothing", async (badScope) => {
    const { home } = await setup();
    const dirs = memoryDirectories(home, projectKey(home, (cwd) => cwd));
    const goodScope = badScope === "project" ? "global" : "project";
    const store = createFileMemoryStore({ home, cwd: home, findRoot: (cwd) => cwd });
    for (const scope of ["global", "project"] as const) expect((await store.write({ ...input, scope })).ok).toBe(true);
    const unreadable = join(dirs[badScope], "coffee.md");
    const seam = new Proxy(fs, { get(target, key) {
      if (key !== "lstat") return Reflect.get(target, key);
      return async (...args: Parameters<typeof fs.lstat>) => {
        if (args[0] === unreadable) throw Object.assign(new Error(`EACCES: permission denied, lstat '${unreadable}'`), { code: "EACCES" });
        return fs.lstat(...args);
      };
    } });
    const failing = createFileMemoryStore({ home, cwd: home, fs: seam, findRoot: (cwd) => cwd });
    const result = await failing.remove({ name: "coffee" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/explicit scope/i);
      expect(result.error).toContain(badScope);
    }
    for (const scope of ["global", "project"] as const) expect(await fs.exists(join(dirs[scope], "coffee.md"))).toBe(true);
    expect((await failing.remove({ name: "coffee", scope: goodScope })).ok).toBe(true);
    expect(await fs.exists(join(dirs[goodScope], "coffee.md"))).toBe(false);
    expect(await fs.exists(join(dirs[badScope], "coffee.md"))).toBe(true);
  });

  test.each(["project", "global"] as const)("refuses unscoped removal when the %s directory is unsafe", async (badScope) => {
    const { home, store } = await setup();
    const dirs = memoryDirectories(home, projectKey(home, (cwd) => cwd));
    const goodScope = badScope === "project" ? "global" : "project";
    expect((await store.write({ ...input, scope: goodScope })).ok).toBe(true);
    const outside = join(home, "outside");
    await fs.mkdir(outside);
    await fs.mkdir(join(dirs[badScope], ".."), { recursive: true });
    await fs.symlink(outside, dirs[badScope]);
    const explicit = await store.remove({ name: "coffee", scope: badScope });
    expect(explicit).toMatchObject({ ok: false, error: expect.stringContaining(dirs[badScope]) });
    const result = await store.remove({ name: "coffee" });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/explicit scope/i) });
    expect(await fs.exists(join(dirs[goodScope], "coffee.md"))).toBe(true);
    expect(await store.remove({ name: "coffee", scope: goodScope })).toMatchObject({ ok: true });
    expect(await fs.exists(join(dirs[goodScope], "coffee.md"))).toBe(false);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  test("unresolved project root refuses same-name removal before any unlink", async () => {
    const { home } = await setup();
    const cwd = join(home, "project");
    const options = { home, cwd, findRoot: (cwd: string) => cwd };
    const dirs = memoryDirectories(home, projectKey(cwd, options.findRoot));
    const store = createFileMemoryStore(options);
    for (const scope of ["global", "project"] as const) expect((await store.write({ ...input, scope })).ok).toBe(true);
    const global = join(dirs.global, "coffee.md"), project = join(dirs.project, "coffee.md");
    const projectBefore = await fs.readFile(project, "utf8");
    await fs.symlink(cwd, cwd);
    const unlinks: string[] = [];
    const seam = new Proxy(fs, { get(target, key) {
      if (key !== "unlink") return Reflect.get(target, key);
      return async (...args: Parameters<typeof fs.unlink>) => { unlinks.push(String(args[0])); return fs.unlink(...args); };
    } });
    const rootless = createFileMemoryStore({ ...options, fs: seam });
    expect(await rootless.list({ scope: "project" })).toMatchObject({ ok: false, error: expect.stringContaining("cannot resolve project root: ELOOP") });
    const result = await rootless.remove({ name: "coffee" });
    expect(unlinks).toEqual([]);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/explicit scope/i), skippedScopes: [{ scope: "project", reason: expect.stringContaining("ELOOP") }] });
    expect(await fs.exists(global)).toBe(true);
    expect(await fs.readFile(project, "utf8")).toBe(projectBefore);
    expect(await rootless.remove({ name: "coffee", scope: "global" })).toEqual({ ok: true });
    expect(unlinks).toEqual([global]);
    expect(await fs.exists(global)).toBe(false);
    expect(await fs.readFile(project, "utf8")).toBe(projectBefore);
  });

  test("two non-removable entries give a clear error, never ambiguity", async () => {
    const { home, store } = await setup();
    const dirs = memoryDirectories(home, projectKey(home, (cwd) => cwd));
    for (const dir of Object.values(dirs)) { await fs.mkdir(dir, { recursive: true }); await fs.mkdir(join(dir, "coffee.md")); }
    const result = await store.remove({ name: "coffee" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/regular.*non-symlink/);
  });
  test("updates skip similarity reads before committing; derived refresh may read headers", async () => {
    const { home, store } = await setup();
    await store.write(input);
    let reads = 0, committed = false;
    const seam = new Proxy(fs, { get(target, key) {
      if (key === "rename") return async (...args: Parameters<typeof fs.rename>) => {
        await fs.rename(...args);
        if (String(args[1]).endsWith("coffee.md")) committed = true;
      };
      if (key === "open") return async (...args: Parameters<typeof fs.open>) => {
        if (!committed && String(args[0]).endsWith("coffee.md")) reads++;
        return fs.open(...args);
      };
      return Reflect.get(target, key);
    } });
    const updater = createFileMemoryStore({ home, cwd: home, fs: seam, findRoot: (cwd) => cwd });
    expect((await updater.write({ ...input, body: "updated" })).ok).toBe(true);
    expect(reads).toBe(0);
  });
  test("near-duplicate check measures descriptions with searchTokens, not raw words", async () => {
    // Scores measured with the real tokenizer: stop words are dropped, so 3 shared
    // tokens can mean 0.5, 0.6 or 0.75 depending on the union.
    const score = (a: string, b: string) => {
      const x = new Set(searchTokens(a)), y = new Set(searchTokens(b));
      return [...x].filter((token) => y.has(token)).length / new Set([...x, ...y]).size;
    };
    expect(score("Prefer bun for tests", "Prefer bun for builds")).toBe(0.5);
    expect(score("Prefer bun for unit tests", "Prefer bun for unit builds")).toBe(0.6);
    expect(score("Prefer bun for tests", "Prefer bun for running tests")).toBe(0.75);

    const weak = await setup();
    expect((await weak.store.write({ ...input, name: "bun-tests", description: "Prefer bun for tests" })).ok).toBe(true);
    expect((await weak.store.write({ ...input, name: "bun-builds", description: "Prefer bun for builds" })).ok).toBe(true);

    const borderline = await setup();
    expect((await borderline.store.write({ ...input, name: "unit-tests", description: "Prefer bun for unit tests" })).ok).toBe(true);
    expect((await borderline.store.write({ ...input, name: "unit-builds", description: "Prefer bun for unit builds" })).ok).toBe(true);

    const near = await setup();
    expect((await near.store.write({ ...input, name: "bun-tests", description: "Prefer bun for tests" })).ok).toBe(true);
    const refused = await near.store.write({ ...input, name: "run-tests", description: "Prefer bun for running tests" });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/similar memory exists/i), similar: [{ name: "bun-tests", description: "Prefer bun for tests" }] });

    // Identical text is a duplicate even when it has no three-token overlap, as CJK does.
    const cjk = "日本語のメモは簡潔に保つ";
    const same = await setup();
    expect((await same.store.write({ ...input, name: "cjk-one", description: cjk })).ok).toBe(true);
    expect(await same.store.write({ ...input, name: "cjk-two", description: `  ${cjk}  ` })).toMatchObject({ ok: false, error: expect.stringMatching(/similar memory exists/i) });
    // NFC, lowercase and whitespace collapse happen before the equality test.
    expect((await same.store.write({ ...input, name: "tokyo-one", description: "Tokyo 日本語メモ" })).ok).toBe(true);
    expect(await same.store.write({ ...input, name: "tokyo-two", description: "  tokyo   日本語メモ " })).toMatchObject({ ok: false, error: expect.stringMatching(/similar memory exists/i) });
    const distinct = await setup();
    expect((await distinct.store.write({ ...input, name: "cjk-one", description: cjk })).ok).toBe(true);
    expect((await distinct.store.write({ ...input, name: "cjk-two", description: "会議の議事録は共有する" })).ok).toBe(true);

    // Two tokens can never reach the Jaccard rule, however completely they overlap.
    const short = await setup();
    expect((await short.store.write({ ...input, name: "short-one", description: "Bun prefer" })).ok).toBe(true);
    expect((await short.store.write({ ...input, name: "short-two", description: "prefer bun" })).ok).toBe(true);
  });
  test("version numbers remain distinct but genuine duplicates are refused", async () => {
    const { store } = await setup();
    for (const [name, description] of [["node-18-notes", "Legacy runtime compatibility"], ["node-20-notes", "Modern platform support"], ["release-0-17", "First release information"], ["release-0-18", "Second deployment details"]]) {
      expect((await store.write({ ...input, name: name!, description: description! })).ok).toBe(true);
    }
    expect((await store.write({ ...input, name: "the-node-20-notes", description: "Different prose entirely" })).ok).toBe(false);
    expect((await store.write({ ...input, name: "unrelated", description: "Modern platform support" })).ok).toBe(false);
  });
  test("secret refusal identifies fields and instructs removal without leaking content", async () => {
    const { store } = await setup();
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    for (const fields of [["name"], ["description"], ["body"], ["description", "body"]]) {
      const result = await store.write({ ...input, ...Object.fromEntries(fields.map((field) => [field, secret])) });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        for (const field of fields) expect(result.error).toContain(field);
        expect(result.error).toContain("Remove");
        expect(result.error).not.toContain(secret);
      }
    }
  });
  test.each([{ query: "search" }, { query: 42 }, { unknown: "value" }])("write rejects extra keys: %j", async (extra) => {
    const { store } = await setup();
    const result = await store.write({ ...input, description: "bad\nline", ...extra });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown.*key/i);
    expect((await store.list()).entries).toEqual([]);
  });
  test("incognito prevents mutation", async () => {
    const { store } = await setup({ incognito: true });
    expect((await store.write(input)).ok).toBe(false);
    expect((await store.remove({ name: input.name })).ok).toBe(false);
  });
  test("each incognito refusal names the operation it blocks", async () => {
    const { store } = await setup({ incognito: true });
    expect(await store.write(input)).toEqual({ ok: false, error: "Incognito mode prevents writes" });
    expect(await store.refreshIndexFile("global")).toEqual({ ok: false, error: "Incognito mode prevents writes" });
    expect(await store.remove({ name: input.name })).toEqual({ ok: false, error: "Incognito mode prevents removal" });
  });
  test("read, list and ambiguous removal", async () => {
    const { store } = await setup();
    await store.write(input);
    await store.write({ ...input, scope: "project", body: "Project preference" });
    const read = await store.read({ name: input.name });
    expect(read.ok && read.memory.body).toBe("Project preference");
    expect((await store.list({})).entries).toHaveLength(2);
    expect((await store.remove({ name: input.name })).ok).toBe(false);
    expect((await store.remove({ scope: "project", name: input.name })).ok).toBe(true);
    expect((await store.remove({ scope: "project", name: input.name })).ok).toBe(false);
  });
  test("one unreadable memory file is skipped instead of failing its whole scope", async () => {
    const { home, store, dir } = await setup();
    expect((await store.write(input)).ok).toBe(true);
    const unreadable = join(dir, "poison.md");
    await fs.writeFile(unreadable, "---\nname: poison\ndescription: Unreadable file\ntype: user\nupdated: '2026-05-01'\n---\nBody\n");
    const seam = new Proxy(fs, { get(target, key) {
      if (key !== "lstat") return Reflect.get(target, key);
      return async (...args: Parameters<typeof fs.lstat>) => {
        if (args[0] === unreadable) throw Object.assign(new Error(`EACCES: permission denied, lstat '${unreadable}'`), { code: "EACCES" });
        return fs.lstat(...args);
      };
    } });
    const failing = createFileMemoryStore({ home, cwd: home, fs: seam, findRoot: (cwd) => cwd, now: () => new Date("2026-05-01T00:00:00Z") });
    const listed = await failing.list();
    expect(listed).toMatchObject({ ok: true, skipped: 1 });
    expect(listed.ok && listed.entries.map((entry) => entry.name)).toEqual(["coffee"]);
    expect(listed.ok && listed.skippedScopes).toBeUndefined();
    expect(await failing.recall({ query: "coffee" })).toMatchObject({ ok: true, matches: [{ name: "coffee" }] });
    expect(await failing.write({ ...input, name: "tea", description: "Tea is also welcome" })).toEqual({ ok: true, name: "tea", scope: "global", created: true });
    expect((await failing.refreshIndexFile("global")).ok).toBe(true);
    const index = await fs.readFile(join(dir, "MEMORY.md"), "utf8");
    expect(index).toContain("coffee");
    expect(index).not.toContain("poison");
    const unreadableRead = await failing.read({ name: "poison", scope: "global" });
    expect(unreadableRead.ok).toBe(false);
    if (!unreadableRead.ok) {
      expect(unreadableRead.error).toContain("poison");
      expect(unreadableRead.error).toContain("permission denied");
      expect(unreadableRead.error).not.toContain(home);
    }
    expect(await failing.read({ name: "coffee" })).toMatchObject({ ok: true, memory: { name: "coffee" } });
  });
  test("ignores malformed, oversized, symlink and temp files", async () => {
    const { store, dir, home } = await setup();
    await store.write(input);
    await fs.writeFile(join(dir, "bad.md"), "broken");
    await fs.writeFile(join(dir, "huge.md"), "x".repeat(65537));
    await fs.symlink(join(home, "outside"), join(dir, "link.md"));
    await fs.writeFile(join(dir, ".coffee.md.tmp-orphan"), "partial");
    const listed = await store.list({});
    expect(listed.entries).toHaveLength(1);
    expect(listed.skipped).toBe(3);
    expect((await store.read({ scope: "global", name: "link" })).ok).toBe(false);
  });
});
