import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.js";
import { loadConfig } from "../src/config.js";
import { readSessionMeta } from "../src/event-log.js";
import { CanonicalWriter, readCanonicalRecords, readFullSessionCanonicalRecords, emitCanonicalTranscript } from "../src/canonical-transcript.js";

const sessions: Session[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.eventLog.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "canonical-session-"));
  roots.push(root);
  const config = loadConfig();
  config.session.log_dir = root;
  config.memory.enabled = false;
  config.memory.summarizer = "disabled";
  config.context_engine!.enabled = false;
  config.native = { ...config.native!, enabled: false };
  config.skills.enabled = false;
  config.project_detection!.enabled = false;
  const session = Session.createNew("session", root, config);
  sessions.push(session);
  return { session, config, root };
}
function writer(session: Session) {
  return new CanonicalWriter(session.eventLog, (error) => { throw error; });
}

test("new sessions advertise the versioned canonical transcript format", () => {
  const { root } = setup();
  expect(readSessionMeta(root, "session")).toMatchObject({ canonical_transcript: { version: 1 } });
});

test.each([false, true])("resume never adds a marker to older sessions, partial history=%s", async (partial) => {
  const { session, config, root } = setup();
  const meta = readSessionMeta(root, session.id)!;
  expect(meta).toHaveProperty("canonical_transcript");
  delete meta.canonical_transcript;
  writeFileSync(join(root, session.id, "meta.json"), JSON.stringify(meta));
  if (partial) {
    await writer(session).startTurn("old input");
    await writer(session).assistant(1, { role: "assistant", content: "", toolCalls: [{ id: "pending", name: "echo", args: {} }] });
  }
  const before = session.eventLog.readAll({ includeCanonical: true }).filter((e) => e.kind === "canonical_message").length;
  session.eventLog.close();
  const resumed = await Session.resume(session.id, root, config, { suppressLoggerStderr: true });
  sessions.push(resumed);
  expect(readSessionMeta(root, session.id)).not.toHaveProperty("canonical_transcript");
  // Opening a session does not run interruption repair.
  expect(resumed.eventLog.readAll({ includeCanonical: true }).filter((e) => e.kind === "canonical_message")).toHaveLength(before);
});

test("canonical resume preserves the marker and allocates across a reset boundary", async () => {
  const { session, config, root } = setup();
  await writer(session).startTurn("first");
  session.logResetBoundary("/clear");
  session.eventLog.close();
  const resumed = await Session.resume(session.id, root, config, { suppressLoggerStderr: true });
  sessions.push(resumed);
  expect(readSessionMeta(root, session.id)).toMatchObject({ canonical_transcript: { version: 1 } });
  expect(await writer(resumed).startTurn("second")).toBe(2);
  const events = resumed.eventLog.readAll({ includeCanonical: true });
  expect(readFullSessionCanonicalRecords(events).map((r) => r.turnId)).toEqual([1, 2]);
  expect(emitCanonicalTranscript(readCanonicalRecords(events))).toEqual([{ role: "user", content: "second" }]);
});
