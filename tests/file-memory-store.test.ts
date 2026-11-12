import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileMemoryStore } from "../src/file-memory/store.js";

const scratch = tmpdir();
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
  test("updates do not read other memory files", async () => {
    const { home, store } = await setup();
    await store.write(input);
    let reads = 0;
    const seam = new Proxy(fs, { get(target, key) {
      if (key === "open") return async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]).endsWith("coffee.md")) reads++;
        return fs.open(...args);
      };
      return Reflect.get(target, key);
    } });
    const updater = createFileMemoryStore({ home, cwd: home, fs: seam, findRoot: (cwd) => cwd });
    expect((await updater.write({ ...input, body: "updated" })).ok).toBe(true);
    expect(reads).toBe(0);
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
