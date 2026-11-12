import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileMemoryStore } from "../src/file-memory/store.js";
import { parseMemory } from "../src/file-memory/format.js";
import { spawnMemoryChild, waitForLine } from "./helpers/file-memory-process.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
const old = { scope: "global" as const, type: "user" as const, name: "victim", description: "Abrupt termination fixture", body: "Old complete content" };

function expectSigkill(exited: number | null, signalCode: string | null) {
  expect(exited).not.toBe(0);
  expect(signalCode).toBe("SIGKILL");
}

test.each([null, 1, 137])("SIGKILL assertions accept runtime exit status %s", (exited) => {
  expectSigkill(exited, "SIGKILL");
});

test("SIGKILL assertions reject successful exits and other signals", () => {
  expect(() => expectSigkill(0, "SIGKILL")).toThrow();
  expect(() => expectSigkill(137, "SIGTERM")).toThrow();
  expect(() => expectSigkill(137, null)).toThrow();
});

test.each([true, false])("SIGKILL at temp-written-before-rename preserves the target (existing=%s)", async (existing) => {
  const home = await fs.mkdtemp(join(tmpdir(), "memory-kill-")); homes.push(home);
  const store = createFileMemoryStore({ home, cwd: home, findRoot: (cwd) => cwd });
  if (existing) expect((await store.write(old)).ok).toBe(true);
  const dir = join(home, ".praana/memory"), target = join(dir, "victim.md");
  const before = existing ? await fs.readFile(target, "utf8") : null;
  const replacement = "Replacement complete content. ".repeat(50);
  const child = await spawnMemoryChild(home, `
    const seam = new Proxy(fs, { get(target, key) {
      if (key !== "open") return Reflect.get(target, key);
      return async (...args) => {
        const handle = await fs.open(...args);
        if (!String(args[0]).includes(".victim.md.tmp-")) return handle;
        return new Proxy(handle, { get(h, method) {
          if (method === "writeFile") return async (...writeArgs) => {
            await handle.writeFile(...writeArgs);
            console.log("CHECKPOINT:temp-written-before-rename");
            await new Promise(() => { setInterval(() => {}, 1000); });
          };
          const value = Reflect.get(h, method);
          return typeof value === "function" ? value.bind(h) : value;
        } });
      };
    } });
    const result = await createFileMemoryStore({ ...storeOptions, fs: seam }).write(${JSON.stringify({ ...old, body: replacement })});
    throw new Error("Writer passed the checkpoint: " + JSON.stringify(result));
  `);
  try {
    expect(await waitForLine(child.stdout)).toBe("CHECKPOINT:temp-written-before-rename");
    expect(child.exitCode).toBeNull();
    const temps = (await fs.readdir(dir)).filter((name) => name.startsWith(".victim.md.tmp-"));
    expect(temps).toHaveLength(1);
    expect(parseMemory(await fs.readFile(join(dir, temps[0]!), "utf8"))?.body).toBe(replacement);
    child.kill("SIGKILL");
    await child.exited;
    expectSigkill(child.exitCode, child.signalCode);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(existing ? await fs.readFile(target, "utf8") : await fs.exists(target)).toBe(before ?? false);
    const listed = await store.list();
    expect(listed.ok).toBe(true);
    expect(listed.skipped).toBe(0);
    expect(listed.entries.map((entry) => entry.name)).toEqual(existing ? ["victim"] : []);
    const recalled = await store.recall({ query: "Replacement" });
    expect(recalled).toEqual({ ok: true, matches: [] });
    const index = await store.buildMemoryIndex();
    expect(index.total).toBe(existing ? 1 : 0);
    expect(index.text).not.toContain(".tmp-");
    expect(index.text).not.toContain("Replacement");
    expect(await fs.exists(join(dir, temps[0]!))).toBe(true);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}, 15000);
