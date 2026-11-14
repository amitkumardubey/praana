import { afterEach, expect, spyOn, test } from "bun:test";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileMemoryStore } from "../src/file-memory/store.js";
import * as storeModule from "../src/file-memory/store.js";
import { MEMORY_NAME_PATTERN } from "../src/file-memory/format.js";
import { createFileMemoryTools } from "../src/file-memory/tools.js";
import { normalizeToolParameters } from "../src/turn.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
async function setup() {
  const home = realpathSync(await fs.mkdtemp(join(tmpdir(), "memory-tidy-"))); homes.push(home);
  const options = { home, cwd: home, findRoot: (cwd: string) => cwd };
  const store = createFileMemoryStore(options);
  return { home, options, store, dir: join(home, ".praana/memory"), tools: createFileMemoryTools(store) };
}
const entry = { scope: "global" as const, type: "user" as const, name: "coffee", description: "Morning beverage preference", body: "Use coffee." };

test("each operation reads its input fields exactly once and never enumerates the caller", async () => {
  const { store } = await setup();
  /** Fields read once each, as getter hits, with the caller's own keys never consulted. */
  const counted = (draft: Record<string, unknown>) => {
    const reads: Record<string, number> = {};
    let enumerations = 0;
    const input = new Proxy(draft, {
      get(target, key) { if (typeof key === "string") reads[key] = (reads[key] ?? 0) + 1; return Reflect.get(target, key); },
      ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
    });
    return { input, reads, enumerations: () => enumerations };
  };

  const write = counted({ ...entry });
  expect(await store.write(write.input as never)).toMatchObject({ ok: true, name: entry.name });
  expect(write.reads).toEqual({ scope: 1, type: 1, name: 1, description: 1, body: 1 });
  // The own-keys allow-list is read exactly once, in the same snapshot pass as the fields, so
  // a caller's ownKeys trap cannot answer it with one key list and the scan with another.
  expect(write.enumerations()).toBe(1);

  const read = counted({ name: entry.name, scope: "global" });
  expect((await store.read(read.input as never)).ok).toBe(true);
  expect(read.reads).toEqual({ name: 1, scope: 1 });
  expect(read.enumerations()).toBe(0);

  const remove = counted({ name: entry.name, scope: "global" });
  expect(await store.remove(remove.input as never)).toEqual({ ok: true });
  expect(remove.reads).toEqual({ name: 1, scope: 1 });
  expect(remove.enumerations()).toBe(0);

  // A query recall snapshots its own three fields once each, and enumerates nothing.
  const query = counted({ query: "coffee" });
  expect((await store.recall(query.input as never)).ok).toBe(true);
  expect(query.reads).toEqual({ query: 1, name: 1, scope: 1 });
  expect(query.enumerations()).toBe(0);
});

test("write refuses a field it cannot read through the shared field-read message", async () => {
  const { store, home } = await setup();
  for (const field of ["scope", "type", "name", "description", "body"]) {
    const input = Object.defineProperty({ ...entry }, field, { enumerable: true, get() { throw new Error("getter failed"); } });
    let result: unknown;
    try { result = await store.write(input as never); } catch (error) { result = `threw: ${String(error)}`; }
    // One refusal message, shared with read, remove and recall.
    expect([field, result]).toEqual([field, { ok: false, error: "Memory fields could not be read" }]);
  }
  expect(await fs.exists(join(home, ".praana/memory", `${entry.name}.md`))).toBe(false);
  // A throwing ownKeys trap is a refusal, never an exception out of the store, and the own-key
  // read happens once, in the same pass as the field reads.
  const enumerations: string[] = [];
  const trapping = new Proxy({ ...entry }, { ownKeys() { enumerations.push("ownKeys"); throw new Error("ownKeys failed"); } });
  expect(await store.write(trapping as never)).toEqual({ ok: false, error: "Memory fields could not be read" });
  expect(enumerations).toEqual(["ownKeys"]);
  // A throwing getter for any declared field is the same refusal.
  expect(await fs.exists(join(home, ".praana/memory", `${entry.name}.md`))).toBe(false);
  // A legitimate unknown key still reports the allow-list, not the field-read message.
  expect(await store.write({ ...entry, extra: true } as never)).toEqual({ ok: false, error: "Unknown write input key; allowed keys: scope, type, name, description, body" });
});

test("the store adds no second name pattern to the module surface", () => {
  const exported = Object.keys(storeModule).sort();
  // `MEMORY_NAME_PATTERN` in format.ts is the only name pattern; the store exports none, and
  // the write field lists stay module-private.
  expect(exported.filter((name) => name.includes("PATTERN"))).toEqual([]);
  expect(exported.filter((name) => name.includes("FIELD"))).toEqual(["FIELD_READ_REFUSAL"]);
  expect(exported).toContain("PRIVATE_KEY_HEADER");
});

test("the published schema pattern is the store's name rule and reserved names get one message", async () => {
  const { tools, store } = await setup();
  const nameProperty = (tool: { parameters?: unknown }) => (normalizeToolParameters(tool.parameters) as { properties: Record<string, { pattern?: string; description?: string }> }).properties.name;
  for (const tool of [tools.remember, tools.recall, tools.forget_memory]) {
    // The schema pattern is the validator's own source, so the two cannot drift.
    expect([nameProperty(tool)?.pattern, MEMORY_NAME_PATTERN.source]).toEqual([MEMORY_NAME_PATTERN.source, MEMORY_NAME_PATTERN.source]);
    // The rule text says what the pattern enforces (a plain slug) and who refuses the rest.
    const text = `${nameProperty(tool)?.description ?? ""}`;
    expect(text).toContain("reserved names are refused by the store");
    expect(text).toContain("Invalid memory name");
  }
  for (const reserved of ["memory", "con", "nul"]) {
    for (const call of [
      () => tools.remember.execute({ ...entry, name: reserved }),
      () => tools.recall.execute({ name: reserved }),
      () => tools.forget_memory.execute({ name: reserved, scope: "global" }),
    ]) {
      const result = await call();
      expect([reserved, result]).toEqual([reserved, { ok: false, error: "Invalid memory name" }]);
    }
  }
  expect((await store.list()).entries).toEqual([]);
});
