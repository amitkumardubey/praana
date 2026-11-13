import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileMemoryStore } from "../src/file-memory/store.js";
import { createFileMemoryTools } from "../src/file-memory/tools.js";
import { memoryDirectories, projectKey } from "../src/file-memory/paths.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
async function setup() {
  const home = await fs.mkdtemp(join(tmpdir(), "memory-tools-")); homes.push(home);
  const options = { home, cwd: home, findRoot: (cwd: string) => cwd };
  const store = createFileMemoryStore(options);
  return { home, options, store, tools: createFileMemoryTools(store) };
}
const entry = { scope: "global", type: "user", name: "coffee", description: "Morning beverage preference", body: "Use coffee." };
const refused = (result: any) => { expect(result.ok).toBe(false); expect(typeof result.error).toBe("string"); expect(result.error.length).toBeGreaterThan(0); };

test("three inert file memory tools delegate valid operations and expose their limits", async () => {
  const { tools } = await setup();
  expect(Object.keys(tools).sort()).toEqual(["forget_memory", "recall", "remember"]);
  expect(tools.remember.description).toMatch(/2048/);
  expect(tools.remember.description).toMatch(/300/);
  expect(tools.remember.description).toMatch(/Why/);
  expect(tools.recall.description).toMatch(/five|5/);
  expect(tools.forget_memory.description).toMatch(/hard.delete/i);
  expect(await tools.remember.execute(entry)).toMatchObject({ ok: true, created: true });
  expect(await tools.recall.execute({ name: entry.name })).toMatchObject({ ok: true, memory: { body: entry.body } });
  expect(await tools.recall.execute({ query: "coffee" })).toMatchObject({ ok: true, matches: [{ name: entry.name }] });
  expect(await tools.forget_memory.execute({ name: entry.name, scope: "global" })).toEqual({ ok: true });
  refused(await tools.forget_memory.execute({ name: entry.name }));
});

test("remember execute rejects wrong types, missing fields, bad enums and unknown keys", async () => {
  const { tools, store } = await setup();
  const invalid: unknown[] = [null, undefined, [], "text", 1, {}, { ...entry, scope: "other" }, { ...entry, type: "fact" }, { ...entry, extra: true }, { ...entry, query: 42 }];
  for (const field of Object.keys(entry)) {
    const missing = { ...entry } as Record<string, unknown>; delete missing[field]; invalid.push(missing);
    invalid.push({ ...entry, [field]: 42 });
  }
  for (const args of invalid) refused(await tools.remember.execute(args));
  expect((await store.list()).entries).toEqual([]);
});

test("recall and forget execute reject every invalid argument shape", async () => {
  const { tools } = await setup();
  for (const args of [null, undefined, [], "text", {}, { query: 42 }, { name: 42 }, { query: "coffee", name: "coffee" }, { query: "coffee", scope: "global" }, { query: "coffee", extra: true }, { query: "" }, { query: "the and" }]) refused(await tools.recall.execute(args));
  for (const args of [null, undefined, [], "text", {}, { name: 42 }, { name: "coffee", scope: 42 }, { name: "coffee", scope: "other" }, { name: "coffee", extra: true }]) refused(await tools.forget_memory.execute(args));
});

test("remember execute returns all validation and secret refusals, duplicate suggestions and ambiguity", async () => {
  const { tools } = await setup();
  for (const extra of [
    { name: "../escape" }, { name: "con" }, { description: "bad\nline" }, { description: "x".repeat(301) },
    { body: "x".repeat(2049) }, { type: "feedback" }, { type: "project" }, { body: "sk-abcdefghijklmnopqrstuvwxyz123456" },
  ]) refused(await tools.remember.execute({ ...entry, ...extra }));
  expect((await tools.remember.execute(entry)).ok).toBe(true);
  const duplicate = await tools.remember.execute({ ...entry, name: "another" });
  refused(duplicate); expect(duplicate.similar).toEqual([{ name: entry.name, description: entry.description }]);
  expect((await tools.remember.execute({ ...entry, scope: "project" })).ok).toBe(true);
  refused(await tools.forget_memory.execute({ name: entry.name }));
  refused(await tools.recall.execute({ name: "../escape" }));
  refused(await tools.forget_memory.execute({ name: "../escape" }));
});

test("recall tool forwards an explicit scope for by-name lookups after a failed scope scan", async () => {
  const { home, options, store } = await setup();
  const dirs = memoryDirectories(home, projectKey(home, (cwd) => cwd));
  expect((await store.write({ ...entry, name: "portable" })).ok).toBe(true);
  await fs.mkdir(dirs.project, { recursive: true });
  const unreadable = join(dirs.project, "portable.md");
  await fs.writeFile(unreadable, "---\nname: portable\ntype: user\ndescription: Unreadable project copy\n---\n\nBody\n");
  const probes: string[] = [];
  const seam = new Proxy(fs, { get(target, key) {
    if (key !== "lstat") return Reflect.get(target, key);
    return async (...args: Parameters<typeof fs.lstat>) => {
      probes.push(String(args[0]));
      if (args[0] === unreadable) throw Object.assign(new Error(`EACCES: permission denied, lstat '${unreadable}'`), { code: "EACCES" });
      return fs.lstat(...args);
    };
  } });
  const tools = createFileMemoryTools(createFileMemoryStore({ ...options, fs: seam }));
  const unscoped = await tools.recall.execute({ name: "portable" });
  expect(probes).toContain(unreadable);
  expect(unscoped).toMatchObject({ ok: false, error: expect.stringMatching(/explicit scope/i), skippedScopes: [{ scope: "project", reason: expect.stringContaining(unreadable) }] });
  expect(await tools.recall.execute({ name: "portable", scope: "global" })).toMatchObject({ ok: true, memory: { name: "portable", scope: "global" } });
  expect(tools.recall.description).toMatch(/scope/);
  refused(await tools.recall.execute({ query: "coffee", scope: "global" }));
});

test("incognito blocks tool mutations but permits recall", async () => {
  const { tools, options } = await setup();
  expect((await tools.remember.execute(entry)).ok).toBe(true);
  const privateTools = createFileMemoryTools(createFileMemoryStore({ ...options, incognito: true }));
  refused(await privateTools.remember.execute(entry));
  refused(await privateTools.forget_memory.execute({ name: entry.name }));
  expect((await privateTools.recall.execute({ name: entry.name })).ok).toBe(true);
});

test("each execute validates before delegation, preserves store errors and never leaks throws", async () => {
  let calls = 0;
  const rejection = { ok: false as const, error: "Filesystem refused", similar: [{ name: "existing", description: "Details" }] };
  const reject = async () => { calls++; return rejection; };
  const tools = createFileMemoryTools({ write: reject, recall: reject, remove: reject });
  for (const tool of Object.values(tools)) {
    refused(await tool.execute({ unknown: true }));
    const hostile = Object.defineProperty({}, "name", { enumerable: true, get() { throw new Error("Getter failed"); } });
    refused(await tool.execute(hostile));
  }
  expect(calls).toBe(0);
  for (const [tool, args] of [[tools.remember, entry], [tools.recall, { query: "coffee" }], [tools.forget_memory, { name: "coffee" }]] as const) expect(await tool.execute(args)).toEqual(rejection);
  expect(calls).toBe(3);
  for (const thrown of [new Error("I/O failure"), "non-Error failure"]) {
    const fail = async (): Promise<never> => { throw thrown; };
    const throwing = createFileMemoryTools({ write: fail, recall: fail, remove: fail });
    refused(await throwing.remember.execute(entry));
    refused(await throwing.recall.execute({ query: "coffee" }));
    refused(await throwing.forget_memory.execute({ name: "coffee" }));
  }
});
