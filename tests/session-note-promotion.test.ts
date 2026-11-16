import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../src/session.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/memory/index.js";

let session: Session | undefined;
let home: string | undefined;
afterEach(async () => {
  if (session) await session.end("aborted");
  session = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
});
async function start(incognito = false, enabled = true) {
  home = mkdtempSync(join(tmpdir(), "no-note-promotion-"));
  process.env.PRAANA_HOME = home;
  const config = structuredClone(loadConfig());
  config.memory = { ...config.memory, enabled, summarizer: "disabled", db_path: join(home, "context.db") };
  config.native.enabled = false;
  config.context_engine.enabled = false;
  config.context_engine.measurement_mode = false;
  config.skills.enabled = false;
  config.session.log_dir = join(home, "sessions");
  session = await Session.create(home, config, { incognito });
  return session;
}

it.each(["active", "soft", "hard", "retracted", "activity"])("does not promote a %s note to either memory backend", async (state) => {
  const session = await start();
  const remember = spyOn(MemoryStore.prototype, "remember");
  try {
    const note = session.stateGraph.create("note", { text: state === "activity" ? "Read src/index.ts and src/app.ts" : "Prefer explicit module boundaries" });
    if (state === "soft" || state === "hard") session.stateGraph.setTier(note.id, state);
    if (state === "retracted") session.stateGraph.retractObject(note.id);
    expect((await session.end("clean", [])).memory).toBe("noop");
    expect(remember).not.toHaveBeenCalled();
    expect((await session.fileMemory!.list()).entries).toEqual([]);
  } finally { remember.mockRestore(); }
});
it("does not promote multiple surviving notes", async () => {
  const session = await start();
  for (const text of ["First finding", "Second finding", "Third finding"]) session.stateGraph.create("note", { text });
  await session.end("clean", []);
  expect((await session.fileMemory!.list()).entries).toEqual([]);
});
it("does not rewrite a deliberately saved file from a matching note", async () => {
  const session = await start();
  const input = { scope: "global" as const, name: "stable-preference", type: "user" as const, description: "Prefer explicit boundaries", body: "Prefer explicit module boundaries" };
  expect((await session.fileMemory!.write(input)).ok).toBe(true);
  const before = await session.fileMemory!.read({ name: input.name });
  session.stateGraph.create("note", { text: input.body });
  await session.end("clean", []);
  expect(await session.fileMemory!.read({ name: input.name })).toEqual(before);
});
it("keeps notes local in incognito", async () => {
  const session = await start(true);
  session.stateGraph.create("note", { text: "A useful observation" });
  expect((await session.end("clean", [])).memory).toBe("noop");
  expect((await session.fileMemory!.list()).entries).toEqual([]);
});
it("ends safely with notes and memory fully disabled", async () => {
  const session = await start(false, false);
  session.stateGraph.create("note", { text: "A useful observation" });
  expect((await session.end("clean", [])).memory).toBe("skipped");
  expect(session.fileMemory).toBeNull();
});
