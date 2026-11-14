import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createFileMemoryStore } from "../src/file-memory/store.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
async function homeDir() { const home = realpathSync(await fs.mkdtemp(join(tmpdir(), "safety-"))); homes.push(home); return home; }
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

test("a field that cannot be read is refused, never thrown", async () => {
  const home = await homeDir();
  const input = { ...entry };
  let reads = 0;
  Object.defineProperty(input, "name", { enumerable: true, get() {
    reads++;
    throw new Error("redaction failed");
  } });
  const result = await make(home).write(input);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("could not be read");
  expect((await make(home).list({})).entries).toHaveLength(0);
  expect(reads).toBe(1);
});

/** Every path the seam is handed, so a test can prove a hostile field never reaches the
 * filesystem outside the memory directory. */
function recordingSeam(touched: string[]): typeof fs {
  return new Proxy(fs, { get(target, key) {
    const original = Reflect.get(target, key);
    if (typeof original !== "function") return original;
    return (...args: unknown[]) => {
      if (typeof args[0] === "string") touched.push(args[0]);
      return (original as (...a: unknown[]) => unknown).apply(target, args);
    };
  } }) as typeof fs;
}
const outsideHome = (home: string, path: string) => { const rel = relative(home, path); return rel.startsWith("..") || isAbsolute(rel); };
/** A name that reads as a real memory first and as a traversal afterwards. */
function twoFacedName(first: string, then: string) {
  let reads = 0;
  const input = { scope: "global" as const } as Record<string, unknown>;
  Object.defineProperty(input, "name", { enumerable: true, get() { reads++; return reads === 1 ? first : then; } });
  return { input, reads: () => reads };
}

const SECRET_TEXT = "key=AKIAIOSFODNN7EXAMPLE and more";
test("read snapshots the name, so a getter cannot validate one name and open another", async () => {
  const home = await homeDir();
  expect((await make(home).write(entry)).ok).toBe(true);
  const victim = join(home, "victim.md");
  await fs.writeFile(victim, "outside the memory directory");
  const touched: string[] = [];
  const { input, reads } = twoFacedName(entry.name, "../../victim");
  const result = await make(home, recordingSeam(touched)).read(input as unknown as { name: string });
  expect(result).toMatchObject({ ok: true, memory: { name: entry.name, scope: "global" } });
  expect(reads()).toBe(1);
  expect(touched.filter((path) => outsideHome(home, path))).toEqual([]);
  expect(await fs.readFile(victim, "utf8")).toBe("outside the memory directory");
});

test("remove snapshots the name, so a getter cannot probe one file and unlink another", async () => {
  const home = await homeDir();
  expect((await make(home).write(entry)).ok).toBe(true);
  const victim = join(home, "victim.md");
  await fs.writeFile(victim, "outside the memory directory");
  const touched: string[] = [];
  const { input, reads } = twoFacedName(entry.name, "../../victim");
  const result = await make(home, recordingSeam(touched)).remove(input as unknown as { name: string });
  expect(result).toMatchObject({ ok: true });
  expect(reads()).toBe(1);
  expect(await fs.readFile(victim, "utf8")).toBe("outside the memory directory");
  expect(await fs.exists(join(home, ".praana/memory/alpha.md"))).toBe(false);
  expect(touched.filter((path) => outsideHome(home, path))).toEqual([]);
});

test("recall snapshots query, name and scope, so a getter cannot validate one query and rank another", async () => {
  const home = await homeDir();
  expect((await make(home).write(entry)).ok).toBe(true);
  const reads: Record<string, number> = {};
  const input: Record<string, unknown> = {};
  for (const field of ["name", "scope"]) {
    Object.defineProperty(input, field, { enumerable: true, get() { reads[field] = (reads[field] ?? 0) + 1; return undefined; } });
  }
  let queryReads = 0;
  Object.defineProperty(input, "query", { enumerable: true, get() { queryReads++; return queryReads === 1 ? "complete" : "zzzz"; } });
  const result = await make(home).recall(input as never);
  expect(result).toMatchObject({ ok: true, matches: [{ name: entry.name }] });
  expect(queryReads).toBe(1);
  expect(reads).toEqual({ name: 1, scope: 1 });
});

test("a field that cannot be read is refused by read, remove and recall, never thrown", async () => {
  const home = await homeDir();
  const store = make(home);
  expect((await store.write(entry)).ok).toBe(true);
  const throwing = (field: string) => Object.defineProperty({ scope: "global", name: entry.name } as Record<string, unknown>, field, { enumerable: true, get() { throw new Error("getter failed"); } });
  const calls = [
    ["read", ["name", "scope"], (input: never) => store.read(input)],
    ["remove", ["name", "scope"], (input: never) => store.remove(input)],
    ["recall", ["query", "name", "scope"], (input: never) => store.recall(input)],
  ] as const;
  for (const [label, fields, call] of calls) {
    for (const field of fields) {
      const result = await call(throwing(field) as never);
      expect([label, field, result]).toEqual([label, field, { ok: false, error: "Memory fields could not be read" }]);
    }
  }
  expect((await store.list({})).entries.map(({ name }) => name)).toEqual([entry.name]);
});

const clean = "A clean description";
/** A getter that answers with clean text for the reads the old code made before the
 * write, and with a secret from then on. */
function scheduled(schedule: string[]) {
  let reads = 0;
  return { reads: () => reads, next() { reads++; return schedule[Math.min(reads - 1, schedule.length - 1)]!; } };
}

async function storedText(home: string) {
  const dir = join(home, ".praana/memory");
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  return (await Promise.all(files.map((file) => fs.readFile(join(dir, file), "utf8")))).join("\n");
}

test("a getter cannot show the scan clean text and the write a secret", async () => {
  const home = await homeDir();
  const value = scheduled([clean, clean, clean, clean, clean, clean, SECRET_TEXT]);
  const input = { scope: "global" as const, type: "user" as const, name: "getter-draft", body: "Clean body" };
  Object.defineProperty(input, "description", { enumerable: true, get: () => value.next() });
  const result = await make(home).write(input);
  expect(await storedText(home)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  if (result.ok) expect((await make(home).read({ name: "getter-draft", scope: "global" }))).toMatchObject({ ok: true, memory: { description: clean } });
  else expect(result.error).not.toContain("AKIAIOSFODNN7EXAMPLE");
  // One snapshot means one read per field, so no read order can split scan from write.
  expect(value.reads()).toBe(1);
});

test("a Proxy that answers differently on every read is snapshotted once", async () => {
  const home = await homeDir();
  const value = scheduled([clean, `${clean} one`, `${clean} two`, `${clean} three`, `${clean} four`, `${clean} five`, SECRET_TEXT]);
  const base = { scope: "global" as const, type: "user" as const, name: "proxy-draft", description: clean, body: "Clean body" };
  const input = new Proxy(base, { get(target, key) { return key === "description" ? value.next() : Reflect.get(target, key); } });
  const result = await make(home).write(input);
  expect(await storedText(home)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  if (result.ok) expect((await make(home).read({ name: "proxy-draft", scope: "global" }))).toMatchObject({ ok: true, memory: { description: clean } });
  else expect(result.error).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect(value.reads()).toBe(1);
});

test("write reads every allowed field exactly once", async () => {
  const home = await homeDir();
  const reads: Record<string, number> = {};
  const draft: Record<string, string> = { scope: "global", type: "user", name: "counted", description: "Counted description", body: "Counted body" };
  const input = {} as Record<string, unknown>;
  for (const [field, value] of Object.entries(draft)) {
    Object.defineProperty(input, field, { enumerable: true, get() { reads[field] = (reads[field] ?? 0) + 1; return value; } });
  }
  expect(await make(home).write(input as never)).toMatchObject({ ok: true, name: "counted", scope: "global", created: true });
  expect(reads).toEqual({ scope: 1, type: 1, name: 1, description: 1, body: 1 });
});

const KEY_HEADERS = [
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN ENCRYPTED PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  "-----BEGIN SECRET KEY BLOCK-----",
  "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----",
  "-----BEGIN  PRIVATE  KEY-----",
  "-----begin private key-----",
  "-----Begin Encrypted Private Key-----",
  "-----begin pgp private key block-----",
];

test("a private key header is refused in any case, dash count or spacing, even truncated", async () => {
  const home = await homeDir();
  const store = make(home);
  const cases: Array<[string, string, Record<string, string>]> = KEY_HEADERS.flatMap((header, index) => [
    // The strict detector needs a matching END line, so a truncated key would be stored.
    [`body-${index}`, "body", { body: `${header}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC` }],
    [`description-${index}`, "description", { description: header }],
    [`name-${index}`, "name", { name: header }],
  ]);
  cases.push(["complete", "body", { body: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----" }]);
  for (const [label, field, extra] of cases) {
    const result = await store.write({ ...entry, name: `key-${label}`, ...extra });
    expect([label, result.ok]).toEqual([label, false]);
    if (result.ok) continue;
    expect(result.error).toContain(field);
    expect(result.error).toContain("Remove the secret-shaped text");
    expect(result.error).not.toContain("MIIE");
  }
  expect(await storedText(home)).not.toContain("PRIVATE KEY");
  // Prose about keys is not a header.
  expect((await store.write({ ...entry, name: "key-rotation", description: "Notes about the private key rotation", body: "We rotate the private key each year." })).ok).toBe(true);
});

test("the header check and the strict scan refuse through one message listing every field", async () => {
  const home = await homeDir();
  const result = await make(home).write({ ...entry, name: "-----BEGIN PRIVATE KEY-----", body: "sk-abcdefghijklmnopqrstuvwxyz123456" });
  expect(result).toEqual({ ok: false, error: "Secret-shaped content refused in name, body. Remove the secret-shaped text before retrying" });
});

test("dangling .praana symlink is reported exactly, creates nothing and skips every scope", async () => {
  const home = await homeDir();
  const base = join(home, ".praana");
  const target = join(home, "missing-target");
  await fs.symlink(target, base);
  const store = make(home);
  const expected = `Dangling .praana symlink: ${base}`;
  // The diagnostic must reach the caller instead of being swallowed as a failed lstat.
  expect(await store.write(entry)).toEqual({ ok: false, error: expected });
  for (const scope of ["global", "project"] as const) {
    expect(await store.list({ scope })).toEqual({ ok: false, error: `${scope}: ${expected}`, skippedScopes: [{ scope, reason: expected }], entries: [], skipped: 0 });
  }
  expect(await store.list()).toEqual({ ok: false, error: `project: ${expected}; global: ${expected}`, skippedScopes: [{ scope: "project", reason: expected }, { scope: "global", reason: expected }], entries: [], skipped: 0 });
  expect((await store.read({ name: entry.name })).ok).toBe(false);
  // Nothing was created behind the dangling link.
  expect(await fs.exists(target)).toBe(false);
  expect(await fs.exists(join(base, "memory"))).toBe(false);
  expect((await fs.lstat(base)).isSymbolicLink()).toBe(true);
});

test("trusts symlinked .praana and symlinks above it", async () => {
  const home = await homeDir(), dotfiles = await homeDir();
  await fs.symlink(dotfiles, join(home, ".praana"));
  const alias = join(await homeDir(), "alias");
  await fs.symlink(home, alias);
  const store = make(alias);
  expect((await store.write(entry)).ok).toBe(true);
  expect((await store.read({ name: entry.name })).ok).toBe(true);
  expect((await store.list({})).entries).toHaveLength(1);
  expect((await store.remove({ name: entry.name })).ok).toBe(true);
  expect(await fs.exists(join(dotfiles, "memory/alpha.md"))).toBe(false);
});

for (const component of ["memory", "projects", "key", "project-memory"]) {
  test(`refuses symlink below .praana: ${component}`, async () => {
    const home = await homeDir(), outside = await homeDir();
    const { projectKey } = await import("../src/file-memory/paths.js");
    const base = join(home, ".praana");
    const key = projectKey(home, (cwd) => cwd);
    const path = component === "memory" ? join(base, "memory") : component === "projects" ? join(base, "projects") : component === "key" ? join(base, "projects", key) : join(base, "projects", key, "memory");
    await fs.mkdir(join(path, ".."), { recursive: true });
    await fs.symlink(outside, path);
    const store = make(home);
    expect((await store.write({ ...entry, scope: component === "memory" ? "global" : "project" })).ok).toBe(false);
    const scope = component === "memory" ? "global" : "project";
    expect((await store.list({ scope })).ok).toBe(false);
    expect(await store.list()).toMatchObject({ ok: true, skippedScopes: [{ scope, reason: expect.stringContaining(path) }] });
    expect(await fs.readdir(outside)).toEqual([]);
  });
}

test.each(["project", "global"] as const)("list and query recall skip an unsafe %s directory", async (badScope) => {
  const home = await homeDir(), outside = await homeDir();
  const { memoryDirectories, projectKey } = await import("../src/file-memory/paths.js");
  const dirs = memoryDirectories(home, projectKey(home, (cwd) => cwd));
  const store = make(home), goodScope = badScope === "project" ? "global" : "project";
  expect((await store.write({ ...entry, scope: goodScope })).ok).toBe(true);
  await fs.mkdir(join(dirs[badScope], ".."), { recursive: true });
  await fs.symlink(outside, dirs[badScope]);
  const warnings = [{ scope: badScope, reason: expect.stringContaining(dirs[badScope]) }];
  const listed = await store.list();
  expect(listed).toMatchObject({ ok: true, skippedScopes: warnings });
  expect(listed.entries.map(({ name, scope }) => ({ name, scope }))).toEqual([{ name: "alpha", scope: goodScope }]);
  const recalled = await store.recall({ query: "complete" });
  expect(recalled).toMatchObject({ ok: true, matches: [{ name: "alpha", scope: goodScope }], skippedScopes: warnings });
  expect(await store.list({ scope: badScope })).toMatchObject({ ok: false, error: expect.stringContaining(dirs[badScope]) });
  const index = await store.buildMemoryIndex();
  expect(index).toMatchObject({ ok: true, total: 1, skippedScopes: warnings });
  await fs.rm(dirs[goodScope], { recursive: true });
  await fs.symlink(outside, dirs[goodScope]);
  for (const result of [await store.list(), await store.recall({ query: "complete" }), await store.remove({ name: "alpha" })]) {
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Unsafe memory directory"), skippedScopes: expect.arrayContaining(warnings) });
  }
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("unavailable scope is reported while the other scope remains usable", async () => {
  const home = await homeDir();
  const { memoryDirectories, projectKey } = await import("../src/file-memory/paths.js");
  const dirs = memoryDirectories(home, projectKey(home, (cwd) => cwd));
  const store = make(home);
  for (const scope of ["project", "global"] as const) expect((await store.write({ ...entry, scope })).ok).toBe(true);
  await fs.chmod(dirs.project, 0);
  try {
    const warnings = [{ scope: "project", reason: expect.stringContaining("EACCES") }];
    expect(await store.list()).toMatchObject({ ok: true, entries: [{ name: "alpha", scope: "global" }], skippedScopes: warnings });
    expect(await store.recall({ query: "complete" })).toMatchObject({ ok: true, matches: [{ name: "alpha", scope: "global" }], skippedScopes: warnings });
    expect(await store.remove({ name: "alpha" })).toMatchObject({ ok: false, error: expect.stringMatching(/explicit scope/i), skippedScopes: warnings });
    expect(await fs.exists(join(dirs.global, "alpha.md"))).toBe(true);
    expect(await store.remove({ name: "alpha", scope: "global" })).toMatchObject({ ok: true });
  } finally { await fs.chmod(dirs.project, 0o700); }
});

test("refuses even contained symlinks below the trusted root", async () => {
  const home = await homeDir();
  const base = join(home, ".praana");
  await fs.mkdir(join(base, "real"), { recursive: true });
  await fs.symlink(join(base, "real"), join(base, "memory"));
  expect((await make(home).write(entry)).ok).toBe(false);
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
