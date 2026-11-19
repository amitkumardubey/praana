import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/event-log.js";
import { SESSION_START_EPOCH } from "../src/frozen-summary.js";
import {
  PREFIX_FORMAT_VERSION,
  PREFIX_GENERATION_KIND,
  readCurrentPrefixGeneration,
  writePrefixGeneration,
  type PrefixGenerationInput,
} from "../src/prompt/prefix-generation.js";
import { buildToolGeneration, type ToolWireDef } from "../src/prompt/tools.js";
import type { Event } from "../src/types.js";

const dirs: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs.splice(0)) log.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "praana-prefix-"));
  dirs.push(dir);
  return dir;
}

function openLog(root: string, session = "s"): EventLog {
  const log = new EventLog(session, root);
  logs.push(log);
  return log;
}

const tools: ToolWireDef[] = [
  { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "edit_file", description: "Edit a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
];

function input(overrides: Partial<PrefixGenerationInput> = {}): PrefixGenerationInput {
  return {
    frame: "You are PRAANA v1\n\n## Project Context\n\nUse strict TypeScript. 界😀",
    snapshot: "# Session Snapshot\n\nCurrent date: 2026-11-19\n",
    tools: buildToolGeneration(tools, { reasoning: "high" }),
    ...overrides,
  };
}

function raw(log: EventLog): Event[] {
  return log.readAll({ includeInternal: true });
}

/** A hand-built prefix event for the validation tests. */
function prefixEvent(payload: Record<string, unknown>, id = "p"): Event {
  return { event_id: id, session_id: "s", timestamp: 1, kind: PREFIX_GENERATION_KIND as Event["kind"], actor: "kernel", payload };
}

function validPayload(generation = 1, epoch: string = SESSION_START_EPOCH): Record<string, unknown> {
  const generated = buildToolGeneration(tools);
  return {
    format_version: PREFIX_FORMAT_VERSION,
    prefix_generation: generation,
    reset_epoch: epoch,
    frame: "frame",
    snapshot: "snapshot",
    tool_generation: { id: generated.id, tools: generated.tools, capabilityChoices: generated.capabilityChoices },
  };
}

function expectError(events: Event[], code: string, index: number) {
  const result = readCurrentPrefixGeneration(events);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
    expect(result.error.eventIndex).toBe(index);
  }
}

describe("prefix generation persistence", () => {
  test("round-trips the frame, snapshot and tools byte for byte", () => {
    const log = openLog(tempRoot());
    const written = writePrefixGeneration(log, input());
    const read = readCurrentPrefixGeneration(raw(log));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.generation).toEqual(written);
    expect(read.generation!.frame).toBe(input().frame);
    expect(read.generation!.snapshot).toBe(input().snapshot);
    expect(JSON.stringify(read.generation!.tools)).toBe(JSON.stringify(input().tools));
    expect(read.generation!.prefixGeneration).toBe(1);
    expect(read.generation!.resetEpoch).toBe(SESSION_START_EPOCH);
    expect(read.generation!.carried).toBe(false);
  });

  test("stores text verbatim, including secret-like strings", () => {
    const secret = "api_key = sk-proj-ABCDEF0123456789abcdef0123456789 and AKIAIOSFODNN7EXAMPLE";
    const root = tempRoot();
    const log = openLog(root);
    writePrefixGeneration(log, input({ frame: `rules: ${secret}`, snapshot: `memory: ${secret}` }));
    const read = readCurrentPrefixGeneration(raw(log));
    expect(read.ok && read.generation?.frame).toBe(`rules: ${secret}`);
    expect(read.ok && read.generation?.snapshot).toBe(`memory: ${secret}`);
    expect(readFileSync(join(root, "s", "events.jsonl"), "utf8")).not.toContain("REDACTED");
  });

  test("returns null when the log has no prefix event", () => {
    const log = openLog(tempRoot());
    log.append({ kind: "user_message", actor: "user", payload: { text: "hi" } });
    expect(readCurrentPrefixGeneration(raw(log))).toEqual({ ok: true, generation: null });
    expect(readCurrentPrefixGeneration([])).toEqual({ ok: true, generation: null });
  });

  test("is an internal event: hidden from default reads, visible when included", () => {
    const log = openLog(tempRoot());
    writePrefixGeneration(log, input());
    expect(log.readAll().some((e) => e.kind === PREFIX_GENERATION_KIND)).toBe(false);
    expect(log.readAll({ includeInternal: true }).filter((e) => e.kind === PREFIX_GENERATION_KIND)).toHaveLength(1);
  });

  test("writes one event per generation and picks the latest", () => {
    const log = openLog(tempRoot());
    writePrefixGeneration(log, input({ frame: "first" }));
    const second = writePrefixGeneration(log, input({ frame: "second" }));
    expect(second.prefixGeneration).toBe(2);
    expect(raw(log).filter((e) => e.kind === PREFIX_GENERATION_KIND)).toHaveLength(2);
    const read = readCurrentPrefixGeneration(raw(log));
    expect(read.ok && read.generation?.frame).toBe("second");
    expect(read.ok && read.generation?.prefixGeneration).toBe(2);
  });

  test("/clear then resume reproduces the same frame, snapshot and tool bytes", () => {
    const root = tempRoot();
    const log = openLog(root);
    writePrefixGeneration(log, input());
    log.logResetBoundary("/clear");
    log.close();

    const reopened = openLog(root);
    const read = readCurrentPrefixGeneration(raw(reopened));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.generation!.carried).toBe(true);
    expect(read.generation!.frame).toBe(input().frame);
    expect(read.generation!.snapshot).toBe(input().snapshot);
    expect(JSON.stringify(read.generation!.tools)).toBe(JSON.stringify(input().tools));
  });

  test("a generation written after /clear belongs to the new epoch and numbering continues", () => {
    const log = openLog(tempRoot());
    writePrefixGeneration(log, input({ frame: "before" }));
    log.logResetBoundary("/clear");
    const boundary = raw(log).at(-1)!;
    const after = writePrefixGeneration(log, input({ frame: "after" }));
    expect(after.prefixGeneration).toBe(2);
    expect(after.resetEpoch).toBe(boundary.event_id);
    const read = readCurrentPrefixGeneration(raw(log));
    expect(read.ok && read.generation?.frame).toBe("after");
    expect(read.ok && read.generation?.carried).toBe(false);

    log.logResetBoundary("/clear");
    const carried = readCurrentPrefixGeneration(raw(log));
    expect(carried.ok && carried.generation?.frame).toBe("after");
    expect(carried.ok && carried.generation?.carried).toBe(true);
  });

  test("reopening the JSONL log from disk gives the same bytes", () => {
    const root = tempRoot();
    const log = openLog(root);
    const written = writePrefixGeneration(log, input());
    log.close();
    const reopened = openLog(root);
    const read = readCurrentPrefixGeneration(raw(reopened));
    expect(read.ok && read.generation).toEqual(written);
  });

  test("refuses to write on top of an invalid prefix event, and rejects a forged tool id", () => {
    const log = openLog(tempRoot());
    log.append({ kind: PREFIX_GENERATION_KIND as Event["kind"], actor: "kernel", payload: { format_version: "prompt-v0" } });
    expect(() => writePrefixGeneration(log, input())).toThrow(/Cannot write a prefix generation/);

    const clean = openLog(tempRoot());
    expect(() => writePrefixGeneration(clean, input({ tools: { ...input().tools, id: "forged" } }))).toThrow(/does not match/);
  });
});

describe("prefix generation validation", () => {
  test("a valid hand-built event is accepted", () => {
    const read = readCurrentPrefixGeneration([prefixEvent(validPayload())]);
    expect(read.ok).toBe(true);
  });

  test("rejects an unknown format version", () => {
    expectError([prefixEvent({ ...validPayload(), format_version: "prompt-v2" })], "unsupported_version", 0);
  });

  test("rejects non-monotonic generations", () => {
    expectError([prefixEvent(validPayload(2))], "non_monotonic_generation", 0);
    expectError([prefixEvent(validPayload(1), "a"), prefixEvent(validPayload(3), "b")], "non_monotonic_generation", 1);
    expectError([prefixEvent(validPayload(1), "a"), prefixEvent(validPayload(1), "b")], "non_monotonic_generation", 1);
    expectError([prefixEvent(validPayload(1), "a"), prefixEvent(validPayload(2), "b"), prefixEvent(validPayload(1), "c")], "non_monotonic_generation", 2);
  });

  test("rejects malformed payloads", () => {
    const base = validPayload();
    const cases: Record<string, unknown>[] = [
      { ...base, extra: true },
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== "snapshot")),
      { ...base, frame: 42 },
      { ...base, snapshot: null },
      { ...base, reset_epoch: "" },
      { ...base, prefix_generation: "1" },
      { ...base, prefix_generation: 1.5 },
      { ...base, prefix_generation: 0 },
      { ...base, format_version: 1 },
      { ...base, tool_generation: "nope" },
      { ...base, tool_generation: { ...(base.tool_generation as object), tools: "x" } },
      { ...base, tool_generation: { ...(base.tool_generation as object), extra: 1 } },
      { ...base, tool_generation: { ...(base.tool_generation as object), tools: [{ name: "a" }] } },
      { ...base, tool_generation: { ...(base.tool_generation as object), capabilityChoices: [] } },
    ];
    for (const payload of cases) expectError([prefixEvent(payload)], "invalid_payload", 0);
    expectError([prefixEvent(base), { ...prefixEvent({}), event_id: "q", payload: [] as never }], "invalid_payload", 1);
  });

  test("rejects a tool generation whose id does not match its tools", () => {
    const base = validPayload();
    const gen = base.tool_generation as { id: string; tools: ToolWireDef[]; capabilityChoices: unknown };
    expectError([prefixEvent({ ...base, tool_generation: { ...gen, id: "0".repeat(64) } })], "tool_generation_mismatch", 0);
    const edited = gen.tools.map((tool, i) => (i === 0 ? { ...tool, description: "changed" } : tool));
    expectError([prefixEvent({ ...base, tool_generation: { ...gen, tools: edited } })], "tool_generation_mismatch", 0);
    expectError([prefixEvent({ ...base, tool_generation: { ...gen, tools: [...gen.tools].reverse() } })], "tool_generation_mismatch", 0);
    expectError([prefixEvent({ ...base, tool_generation: { ...gen, capabilityChoices: { extra: 1 } } })], "tool_generation_mismatch", 0);
  });

  test("rejects a reset epoch that does not match the log position", () => {
    expectError([prefixEvent(validPayload(1, "some-boundary"))], "invalid_epoch", 0);
    const boundary: Event = { event_id: "b1", session_id: "s", timestamp: 1, kind: "system_note", actor: "kernel", payload: { type: "reset_boundary", command: "/clear" } };
    expectError([boundary, prefixEvent(validPayload(1, SESSION_START_EPOCH))], "invalid_epoch", 1);
    expect(readCurrentPrefixGeneration([boundary, prefixEvent(validPayload(1, "b1"))]).ok).toBe(true);
  });

  test("an invalid older event is never skipped, and the reader does not throw", () => {
    const events = [prefixEvent({ ...validPayload(1), format_version: "prompt-v9" }, "a"), prefixEvent(validPayload(2), "b")];
    expect(() => readCurrentPrefixGeneration(events)).not.toThrow();
    expectError(events, "unsupported_version", 0);
  });

  test("tool lists that cannot be canonicalized are reported, not thrown", () => {
    const base = validPayload();
    const gen = base.tool_generation as { id: string; tools: ToolWireDef[]; capabilityChoices: unknown };
    const duplicated = [gen.tools[0]!, gen.tools[0]!];
    expectError([prefixEvent({ ...base, tool_generation: { ...gen, tools: duplicated } })], "invalid_payload", 0);
  });
});
