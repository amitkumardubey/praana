import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileMemoryStore } from "../src/file-memory/store.js";
import { parseMemory, serializeMemory } from "../src/file-memory/format.js";
import { readRemainingText, spawnBarrierMemoryChild, waitForLine } from "./helpers/file-memory-process.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
async function setup() {
  const home = await fs.mkdtemp(join(tmpdir(), "memory-concurrency-")); homes.push(home);
  const options = { home, cwd: home, findRoot: (cwd: string) => cwd, now: () => new Date("2026-05-01T00:00:00Z") };
  return { home, options, store: createFileMemoryStore(options) };
}
const fixture = (writer: string, i: number) => ({ scope: "global" as const, type: "user" as const, name: `${writer}-${i}`, description: `${writer}detail${i}`, body: `${writer} complete body ${i}: ` + writer.repeat(80) });
const shared = (writer: string) => ({ ...fixture(writer, 99), name: "shared", description: `${writer}sharedfixture` });

async function assertSurvivors(home: string) {
  const store = createFileMemoryStore({ home, cwd: home, findRoot: (cwd) => cwd });
  const expected = ["shared", ...["alpha", "beta"].flatMap((writer) => [1, 3, 5, 7].map((i) => `${writer}-${i}`))].sort();
  const listed = await store.list();
  expect(listed.ok).toBe(true); expect(listed.skipped).toBe(0);
  expect(listed.entries.map((entry) => entry.name).sort()).toEqual(expected);
  for (const writer of ["alpha", "beta"]) for (const i of [1, 3, 5, 7]) {
    const read = await store.read({ name: `${writer}-${i}` });
    expect(read.ok && read.memory).toMatchObject(fixture(writer, i));
    const raw = await fs.readFile(join(home, ".praana/memory", `${writer}-${i}.md`), "utf8");
    expect(raw).toBe(serializeMemory({ ...fixture(writer, i), updated: "2026-05-01" }));
  }
  const raw = await fs.readFile(join(home, ".praana/memory/shared.md"), "utf8");
  expect(["alpha", "beta"].map((writer) => serializeMemory({ ...shared(writer), updated: "2026-05-01" }))).toContain(raw);
  expect(parseMemory(raw)?.name).toBe("shared");
  const index = await store.buildMemoryIndex();
  expect(index).toMatchObject({ total: expected.length, shown: expected.length, truncated: false });
  expect([...index.text.matchAll(/^- \[([^\]]+)\]\(([a-z0-9-]+\.md)\) \(user, \d+d\) /gm)].map((match) => match[1]).sort()).toEqual(expected);
  expect(index.text).not.toContain(".tmp-");
}

test("barrier-synchronised processes preserve exact unique survivors and one complete shared version", async () => {
  const { home } = await setup();
  const children: Awaited<ReturnType<typeof spawnBarrierMemoryChild>>[] = [];
  try {
    for (const writer of ["alpha", "beta"]) {
      const fixtures = Array.from({ length: 8 }, (_, i) => fixture(writer, i));
      children.push(await spawnBarrierMemoryChild(home, `
        const store = createFileMemoryStore(storeOptions);
        const results = [];
        function check(label, result) {
          results.push({ label, result });
          if (!result.ok) throw new Error(label + ": " + JSON.stringify(result));
        }
        const fixtures = ${JSON.stringify(fixtures)};
        for (let i = 0; i < fixtures.length; i++) {
          check("write:" + i, await store.write(fixtures[i]));
          if (i % 2 === 0) check("remove:" + i, await store.remove({ name: fixtures[i].name }));
          check("list:" + i, await store.list());
        }
        check("shared", await store.write(${JSON.stringify(shared(writer))}));
        console.log(JSON.stringify(results));
      `));
    }
    for (const child of children) expect(await waitForLine(child.stdout)).toBe("READY:awaiting-start");
    for (const child of children) { child.stdin.write("START\n"); await child.stdin.end(); }
    for (const child of children) {
      const output = await readRemainingText(child.stdout);
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      const results = JSON.parse(output) as Array<{ label: string; result: { ok: boolean } }>;
      const labels = Array.from({ length: 8 }, (_, i) => [`write:${i}`, ...(i % 2 === 0 ? [`remove:${i}`] : []), `list:${i}`]).flat().concat("shared");
      expect(results.map((row) => row.label)).toEqual(labels);
      for (const row of results) expect(row.result.ok).toBe(true);
    }
    await assertSurvivors(home);
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  }
}, 20000);

test("a target created after the filename snapshot is an upsert, not its own duplicate", async () => {
  const { home, options, store } = await setup();
  const dir = join(home, ".praana/memory");
  await fs.mkdir(dir, { recursive: true });
  let intervened = false;
  const seam = new Proxy(fs, { get(target, key) {
    if (key !== "readdir") return Reflect.get(target, key);
    return async (...args: Parameters<typeof fs.readdir>) => {
      const filenames = await fs.readdir(...args);
      if (!intervened && String(args[0]) === dir) {
        intervened = true;
        expect((await store.write(shared("alpha"))).ok).toBe(true);
      }
      return filenames;
    };
  } });
  const result = await createFileMemoryStore({ ...options, fs: seam }).write(shared("beta"));
  expect(intervened).toBe(true);
  expect(result).toMatchObject({ ok: true, name: "shared" });
  const read = await store.read({ name: "shared" });
  expect(read.ok && read.memory.body).toBe(shared("beta").body);
});

test("in-process overlap supplements the real process test with exact fixtures", async () => {
  const { home, options } = await setup();
  await Promise.all(["alpha", "beta"].map(async (writer) => {
    const store = createFileMemoryStore(options);
    for (let i = 0; i < 8; i++) {
      const entry = fixture(writer, i);
      expect((await store.write(entry)).ok).toBe(true);
      if (i % 2 === 0) expect((await store.remove({ name: entry.name })).ok).toBe(true);
      expect((await store.list()).ok).toBe(true);
    }
    expect(await store.write(shared(writer))).toMatchObject({ ok: true });
  }));
  await assertSurvivors(home);
});

test("barrier-synchronised write/delete race leaves only complete new content or absence", async () => {
  const { home, store } = await setup();
  const initial = { ...fixture("initial", 0), name: "contested", description: "Contested fixture" };
  const replacement = { ...initial, body: "New complete content ".repeat(80) };
  expect((await store.write(initial)).ok).toBe(true);
  const children: Awaited<ReturnType<typeof spawnBarrierMemoryChild>>[] = [];
  try {
    children.push(await spawnBarrierMemoryChild(home, `console.log(JSON.stringify(await createFileMemoryStore(storeOptions).write(${JSON.stringify(replacement)})));`));
    children.push(await spawnBarrierMemoryChild(home, `console.log(JSON.stringify(await createFileMemoryStore(storeOptions).remove({ name: "contested" })));`));
    for (const child of children) expect(await waitForLine(child.stdout)).toBe("READY:awaiting-start");
    for (const child of children) { child.stdin.write("START\n"); await child.stdin.end(); }
    for (const child of children) {
      const output = await readRemainingText(child.stdout);
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      expect(JSON.parse(output).ok).toBe(true);
    }
    const target = join(home, ".praana/memory/contested.md");
    const present = await fs.exists(target);
    if (present) expect(await fs.readFile(target, "utf8")).toBe(serializeMemory({ ...replacement, updated: "2026-05-01" }));
    const listed = await store.list();
    expect(listed.ok).toBe(true); expect(listed.skipped).toBe(0);
    expect(listed.entries.map((entry) => entry.name)).toEqual(present ? ["contested"] : []);
    expect((await store.buildMemoryIndex()).total).toBe(present ? 1 : 0);
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  }
}, 20000);
