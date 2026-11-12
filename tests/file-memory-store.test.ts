import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createFileMemoryStore } from "../src/file-memory/store.js";

const scratch = process.env.TMPDIR!;
const homes: string[] = [];
async function setup(extra: Record<string, unknown> = {}) {
  const home = await fs.mkdtemp(join(scratch, "home-"));
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
  test("incognito prevents mutation", async () => {
    const { store } = await setup({ incognito: true });
    expect((await store.write(input)).ok).toBe(false);
    expect((await store.remove({ name: input.name })).ok).toBe(false);
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
