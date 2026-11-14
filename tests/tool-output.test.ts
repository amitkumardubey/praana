import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalWriter } from "../src/canonical-transcript.js";
import * as compaction from "../src/compaction.js";
import {
  materializeHistory,
  requestFill,
  runCompaction,
  type StubCandidate,
  type StubEntry,
  type StubPlanner,
} from "../src/compaction.js";
import { loadConfig } from "../src/config.js";
import { ArtifactStore } from "../src/context-engine/artifact-store.js";
import { EventLog } from "../src/event-log.js";
import { restoreFrozenState, SUMMARY_HEADINGS } from "../src/frozen-summary.js";
import { estimateTokens } from "../src/token-estimate.js";
import * as toolOutput from "../src/tool-output.js";
import {
  buildToolResultStub,
  DEFAULT_EXACT_BYTES_TOOLS,
  DEFAULT_SHAPE_MAX_BYTES,
  DEFAULT_SHAPE_MAX_LINES,
  planToolResultStubs,
  shapeToolOutput,
} from "../src/tool-output.js";

const tempDirs: string[] = [];
const stores: ArtifactStore[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const log of logs.splice(0)) log.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tool-output ingestion shaper and batch stubber (PR2b)", () => {
  test("shaper keeps head and tail under line/byte caps, states how much was cut and how to retrieve, and is deterministic", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${String(i + 1).padStart(3, "0")}: ${"output-data ".repeat(8)}`);
    const rawText = lines.join("\n");

    let storedRaw: string | undefined;
    const first = shapeToolOutput({
      toolName: "shell",
      command: "bun test",
      text: rawText,
      storeArtifact: (content) => {
        storedRaw = content;
        return { artifactId: "art_test12345678" };
      },
      options: {
        inlineThresholdTokens: 100,
        maxLines: 20,
        headLines: 10,
        tailLines: 10,
      },
    });

    expect(first.shaped).toBe(true);
    expect(first.artifactId).toBe("art_test12345678");
    expect(storedRaw).toBe(rawText);
    expect(first.omittedLines).toBe(180);
    expect(first.omittedBytes).toBeGreaterThan(0);
    expect(first.text).toContain("line-001:");
    expect(first.text).toContain("line-010:");
    expect(first.text).not.toContain("line-011:");
    expect(first.text).not.toContain("line-190:");
    expect(first.text).toContain("line-191:");
    expect(first.text).toContain("line-200:");
    expect(first.text).toContain("art_test12345678");
    expect(first.text).toContain('retrieve_artifact("art_test12345678")');
    expect(first.text).toContain("180 lines");

    // Determinism: identical inputs produce byte-identical output
    const second = shapeToolOutput({
      toolName: "shell",
      command: "bun test",
      text: rawText,
      artifactId: "art_test12345678",
      options: {
        inlineThresholdTokens: 100,
        maxLines: 20,
        headLines: 10,
        tailLines: 10,
      },
    });
    expect(second).toEqual(first);
  });

  test("shaped output is never longer than the input and shaping is idempotent", () => {
    const samples = [
      "",
      "short output",
      "a\nb\nc\nd\ne",
      Array.from({ length: 120 }, (_, i) => `row ${i}: ${"x".repeat(40)}`).join("\n"),
      `single-huge-line-${"0123456789abcdef".repeat(1500)}`,
      `multibyte-${"雪🧪🚀".repeat(2500)}`,
      // Borderline input just above threshold where marker could exceed cut bytes
      "x".repeat(404),
    ];

    for (const raw of samples) {
      let storeCalls = 0;
      const res = shapeToolOutput({
        toolName: "shell",
        text: raw,
        storeArtifact: () => {
          storeCalls++;
          return "art_idempotent01";
        },
        options: {
          inlineThresholdTokens: 100,
          maxLines: 16,
          headLines: 8,
          tailLines: 8,
          maxBytes: 2048,
          headBytes: 1024,
          tailBytes: 1024,
        },
      });

      expect(res.text.length).toBeLessThanOrEqual(raw.length);
      expect(Buffer.byteLength(res.text, "utf8")).toBeLessThanOrEqual(Buffer.byteLength(raw, "utf8"));
      expect(res.shapedTokens).toBeLessThanOrEqual(res.rawTokens);
      if (res.shaped) {
        expect(res.text.length).toBeLessThan(raw.length);
        expect(Buffer.byteLength(res.text, "utf8")).toBeLessThan(Buffer.byteLength(raw, "utf8"));
      }

      // Idempotence: shaping an already-shaped output returns the exact same string and does not store again
      const callsBeforeSecond = storeCalls;
      const again = shapeToolOutput({
        toolName: "shell",
        text: res.text,
        storeArtifact: () => {
          storeCalls++;
          return "art_should_not_be_created";
        },
        options: {
          inlineThresholdTokens: 10,
          maxLines: 16,
          headLines: 8,
          tailLines: 8,
          maxBytes: 2048,
          headBytes: 1024,
          tailBytes: 1024,
        },
      });
      expect(again.text).toBe(res.text);
      expect(again.shaped).toBe(false);
      expect(storeCalls).toBe(callsBeforeSecond);
    }
  });

  test("never shapes exact-bytes inputs (read_file, LSP diagnostics, retrieve_artifact, preserveExactBytes)", () => {
    const exactSourceFile = Array.from(
      { length: 300 },
      (_, i) => `export const line_${i + 1} = "exact indentation and trailing spaces   ";`,
    ).join("\n");
    expect(estimateTokens(exactSourceFile)).toBeGreaterThan(1000);

    for (const toolName of [
      "read_file",
      "lsp_diagnostics",
      "lsp_definition",
      "lsp_references",
      "lsp_hover",
      "lsp_symbols",
      "retrieve_artifact",
    ]) {
      expect(DEFAULT_EXACT_BYTES_TOOLS.has(toolName)).toBe(true);
      let stored = false;
      const result = shapeToolOutput({
        toolName,
        text: exactSourceFile,
        storeArtifact: () => {
          stored = true;
          return "art_unused";
        },
        options: { inlineThresholdTokens: 50, maxLines: 10, headLines: 5, tailLines: 5 },
      });
      expect(result.shaped).toBe(false);
      expect(result.text).toBe(exactSourceFile);
      expect(stored).toBe(false);
    }

    // Explicit preserveExactBytes flag on any tool also leaves bytes untouched
    const custom = shapeToolOutput({
      toolName: "shell",
      text: exactSourceFile,
      preserveExactBytes: true,
      options: { inlineThresholdTokens: 50, maxLines: 10, headLines: 5, tailLines: 5 },
    });
    expect(custom.shaped).toBe(false);
    expect(custom.text).toBe(exactSourceFile);
  });

  test("stores full original in ArtifactStore side file and recovers exact original via retrieve", () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-tool-output-art-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "context.db");
    const store = ArtifactStore.open(dbPath, "sess-pr2b", loadConfig("/nonexistent-praana.toml").context_engine);
    stores.push(store);

    const fullLog = Array.from(
      { length: 250 },
      (_, i) => `[test ${i + 1}] ${i === 125 ? "FAIL: secret assertion error at src/foo.ts:99" : "PASS: ok ".repeat(10)}`,
    ).join("\n");

    const shaped = shapeToolOutput({
      toolName: "shell",
      command: "bun test",
      text: fullLog,
      storeArtifact: (rawText) => {
        const ingested = store.ingestToolResult({
          sourceTool: "shell",
          command: "bun test",
          rawText,
          createdTurn: 1,
        });
        return ingested.artifactId;
      },
      options: { inlineThresholdTokens: 100, maxLines: 20, headLines: 10, tailLines: 10 },
    });

    expect(shaped.shaped).toBe(true);
    expect(shaped.artifactId).toMatch(/^art_[0-9a-f]{12}$/);
    // The middle line 126 was elided from the shaped view
    expect(shaped.text).not.toContain("FAIL: secret assertion error at src/foo.ts:99");
    // Full original is recoverable from the side file by artifactId
    const retrieved = store.retrieve(shaped.artifactId ?? "", 1);
    expect(retrieved).toEqual({ ok: true, content: fullLog });
    const ranged = store.retrieve(shaped.artifactId!, 1, { lineStart: 126, lineEnd: 126 });
    expect(ranged).toEqual({ ok: true, content: "[test 126] FAIL: secret assertion error at src/foo.ts:99" });

    // Degraded mode (artifact store unavailable / returns null): still shapes head/tail and explains fallback
    const degraded = shapeToolOutput({
      toolName: "shell",
      text: fullLog,
      storeArtifact: () => null,
      options: { inlineThresholdTokens: 100, maxLines: 20, headLines: 10, tailLines: 10 },
    });
    expect(degraded.shaped).toBe(true);
    expect(degraded.artifactId).toBeUndefined();
    expect(degraded.text).toContain("search_transcript");
  });

  test("exposes only the shaper, buildToolResultStub, planToolResultStubs, and constants", async () => {
    const mod = await import("../src/tool-output.js");
    expect(Object.keys(mod).sort()).toEqual([
      "DEFAULT_EXACT_BYTES_TOOLS",
      "DEFAULT_INLINE_THRESHOLD_TOKENS",
      "DEFAULT_SHAPE_HEAD_BYTES",
      "DEFAULT_SHAPE_HEAD_LINES",
      "DEFAULT_SHAPE_MAX_BYTES",
      "DEFAULT_SHAPE_MAX_LINES",
      "DEFAULT_SHAPE_TAIL_BYTES",
      "DEFAULT_SHAPE_TAIL_LINES",
      "DEFAULT_STUB_KEEP_RECENT",
      "DEFAULT_STUB_MIN_TOKENS",
      "buildToolResultStub",
      "planToolResultStubs",
      "shapeToolOutput",
    ]);
  });

  test("planToolResultStubs filters by minTokens and builds one-line stubs with event and artifact ids", () => {
    const stubText = buildToolResultStub({
      eventId: "res-1",
      turnId: 1,
      callId: "call-1",
      toolName: "shell",
      text: `head\n... [elided 100 lines / 4000 bytes; full output stored in artifact art_abc123def456 — call retrieve_artifact("art_abc123def456") to inspect] ...\n${"A".repeat(1600)}`,
      isError: false,
      estimatedTokens: 400,
    });
    expect(stubText).not.toContain("\n");
    expect(stubText).toContain("res-1");
    expect(stubText).toContain("art_abc123def456");
    expect(stubText).toContain("search_transcript");
    expect(stubText).toContain("retrieve_artifact");

    const direct = planToolResultStubs(
      [
        {
          eventId: "res-1",
          turnId: 1,
          callId: "call-1",
          toolName: "shell",
          text: `head\n... [elided 100 lines / 4000 bytes; full output stored in artifact art_abc123def456 — call retrieve_artifact("art_abc123def456") to inspect] ...\n${"A".repeat(1600)}`,
          isError: false,
          estimatedTokens: 400,
        },
        {
          eventId: "small-res",
          turnId: 1,
          callId: "call-small",
          toolName: "shell",
          text: "tiny",
          isError: false,
          estimatedTokens: 2,
        },
      ],
      { phase: "stale", minTokens: 256, keepRecent: 3 },
    );
    expect(direct).toEqual([{ eventId: "res-1", stubText }]);
  });

  test("shares StubPlanner types and stub constants from compaction.ts with no local copies or private defaults", () => {
    const planner: StubPlanner = planToolResultStubs;
    expect(typeof planner).toBe("function");
    // No default `= {}` on the options parameter: both parameters are required.
    expect(planToolResultStubs.length).toBe(2);

    // Constants are re-exported from compaction.ts (single source of truth).
    expect(toolOutput.DEFAULT_STUB_KEEP_RECENT).toBe(compaction.DEFAULT_STUB_KEEP_RECENT);
    expect(toolOutput.DEFAULT_STUB_MIN_TOKENS).toBe(compaction.DEFAULT_STUB_MIN_TOKENS);

    // Type compatibility: StubCandidate and StubEntry from compaction.ts match tool-output.ts.
    const candidate: StubCandidate = {
      eventId: "ev-1",
      turnId: 1,
      callId: "call-1",
      toolName: "shell",
      text: "A".repeat(1200),
      isError: false,
      estimatedTokens: 300,
    };
    const entries: readonly StubEntry[] = planner([candidate], {
      phase: "stale",
      minTokens: 200,
      keepRecent: 3,
    });
    expect(entries).toHaveLength(1);
    // Respects the caller's minTokens without falling back to a private default.
    expect(
      planner([candidate], { phase: "stale", minTokens: 400, keepRecent: 3 }),
    ).toEqual([]);

    const source = readFileSync(new URL("../src/tool-output.ts", import.meta.url), "utf8");
    expect(source).toMatch(/import type \{[^}]*\bStubCandidate\b[^}]*\bStubEntry\b[^}]*\bStubPlanner\b[^}]*\} from "\.\/compaction\.js"/);
    expect(source).not.toMatch(/\b(?:export\s+)?interface StubCandidate\b/);
    expect(source).not.toMatch(/\b(?:export\s+)?interface StubEntry\b/);
    expect(source).not.toMatch(/\bDEFAULT_STUB_(?:KEEP_RECENT|MIN_TOKENS)\s*=/);
    expect(source).not.toMatch(/options\.minTokens\s*\?\?/);
  });

  test("integrates with CanonicalWriter and runCompaction across Step 1 (stale) and Step 3 (in-flight)", async () => {
    const validSummary = (active: string) =>
      SUMMARY_HEADINGS.map((h, i) => `### ${h}\n${i === 0 ? active : "- item"}`).join("\n\n");

    const openWorkspace = (sessionId: string) => {
      const dir = mkdtempSync(join(tmpdir(), "praana-tool-output-comp-"));
      tempDirs.push(dir);
      const log = new EventLog(sessionId, dir);
      logs.push(log);
      const store = ArtifactStore.open(
        join(dir, "context.db"),
        sessionId,
        loadConfig("/nonexistent-praana.toml").context_engine,
      );
      stores.push(store);
      const writer = new CanonicalWriter(log, (err) => {
        throw err;
      });
      return { log, store, writer };
    };

    const appendShapedResult = async (
      log: EventLog,
      store: ArtifactStore,
      writer: CanonicalWriter,
      turnId: number,
      callId: string,
      rawText: string,
      shapeOpts?: { inlineThresholdTokens?: number; maxLines?: number; headLines?: number; tailLines?: number; maxBytes?: number; headBytes?: number; tailBytes?: number },
    ) => {
      await writer.assistant(turnId, {
        role: "assistant",
        content: `Running ${callId}`,
        toolCalls: [{ id: callId, name: "shell", args: { cmd: callId } }],
      });
      const shaped = shapeToolOutput({
        toolName: "shell",
        command: callId,
        text: rawText,
        storeArtifact: (content) =>
          store.ingestToolResult({ sourceTool: "shell", command: callId, rawText: content, createdTurn: turnId }).artifactId,
        options: shapeOpts,
      });
      await writer.result(turnId, callId, "shell", shaped.text, false);
      const eventId = log.readAll({ includeInternal: true }).at(-1)!.event_id;
      return { eventId, artifactId: shaped.artifactId, text: shaped.text };
    };

    // --- Part A: Step 1 (stale stubbing outside tailTurns=4) ---
    {
      const { log, store, writer } = openWorkspace("sess-step1");
      const largeBody = (tag: string, lines = 120) =>
        Array.from({ length: lines }, (_, i) => `${tag}-row-${i + 1}: ${"payload-".repeat(8)}`).join("\n");

      // Turn 1 (stale): one large shaped result + one small verbatim result (< minTokens)
      const t1 = (await writer.startTurn("Inspect stale turn 1"))!;
      const stale1 = await appendShapedResult(log, store, writer, t1, "c-stale-1", largeBody("STALE1"), {
        inlineThresholdTokens: 50,
        maxLines: 60,
        headLines: 30,
        tailLines: 30,
      });
      const staleSmall = await appendShapedResult(log, store, writer, t1, "c-stale-small", "small-stale-ok");
      await writer.assistant(t1, { role: "assistant", content: "Turn 1 complete." });

      // Turn 2 (stale): one large shaped result
      const t2 = (await writer.startTurn("Inspect stale turn 2"))!;
      const stale2 = await appendShapedResult(log, store, writer, t2, "c-stale-2", largeBody("STALE2"), {
        inlineThresholdTokens: 50,
        maxLines: 60,
        headLines: 30,
        tailLines: 30,
      });
      await writer.assistant(t2, { role: "assistant", content: "Turn 2 complete." });

      // Turns 3..6 (4 tail completed turns): results that must stay verbatim in Step 1
      const tailRecords: { eventId: string; text: string }[] = [];
      for (let idx = 3; idx <= 6; idx++) {
        const tid = (await writer.startTurn(`Tail turn ${idx}`))!;
        const rec = await appendShapedResult(log, store, writer, tid, `c-tail-${idx}`, `TAIL_${idx}_` + "x".repeat(600));
        tailRecords.push(rec);
        await writer.assistant(tid, { role: "assistant", content: `Turn ${idx} complete.` });
      }

      // Turn 7 (in-flight): result that must stay verbatim in Step 1
      const t7 = (await writer.startTurn("In-flight turn 7"))!;
      const inFlightRec = await appendShapedResult(log, store, writer, t7, "c-inflight-7", "INFLIGHT_7_" + "y".repeat(600));

      expect(stale1.artifactId).toBeDefined();
      expect(stale2.artifactId).toBeDefined();

      // Measure initial request input tokens so Step 1 crosses >= 0.80 down to <= 0.60
      const events = log.readAll({ includeInternal: true });
      const restored = restoreFrozenState(events);
      if (!restored.ok) throw restored.error;
      const mat0 = materializeHistory(restored.state, events);
      if (!mat0.ok) throw mat0.error;
      const initialFill = requestFill({}, mat0.messages, 100_000, { effectiveMaxTokens: 200 });
      if (!initialFill.ok) throw new Error(initialFill.error.message);
      const usableTokens = Math.floor(initialFill.fill.inputTokens / 0.85);

      let summaryCalls = 0;
      const outcome = await runCompaction({
        log,
        liveRequest: { model: "claude-sonnet-4-20250514", provider: "anthropic", messages: [] },
        contextWindowTokens: usableTokens + 200,
        options: { effectiveMaxTokens: 200, tailTurns: 4, stubMinTokens: 200, stubKeepRecent: 3 },
        planStubs: planToolResultStubs,
        runSummary: async () => {
          summaryCalls++;
          return { text: validSummary("unused"), finishReason: "stop", usage: null, toolCalls: [] };
        },
      });

      expect(outcome.status).toBe("stubbed");
      if (outcome.status !== "stubbed") throw new Error(JSON.stringify(outcome));
      expect(summaryCalls).toBe(0);
      expect(outcome.fill.fits).toBe(true);

      const stubMap = new Map(outcome.state.stubSet.map((s) => [s.eventId, s.stubText]));
      expect([...stubMap.keys()].sort()).toEqual([stale1.eventId, stale2.eventId].sort());
      expect(stubMap.get(stale1.eventId)).toContain(stale1.eventId);
      expect(stubMap.get(stale1.eventId)).toContain(stale1.artifactId!);
      expect(stubMap.get(stale1.eventId)!.length).toBeLessThan(stale1.text.length);
      expect(stubMap.get(stale2.eventId)).toContain(stale2.eventId);
      expect(stubMap.get(stale2.eventId)).toContain(stale2.artifactId!);
      expect(stubMap.get(stale2.eventId)!.length).toBeLessThan(stale2.text.length);

      const mat = materializeHistory(outcome.state, log);
      expect(mat.ok).toBe(true);
      if (!mat.ok) throw mat.error;
      const results = mat.messages
        .filter((m): m is Extract<typeof m, { role: "tool_result" }> => m.role === "tool_result")
        .map((m) => m.result);
      expect(results).toContain(stubMap.get(stale1.eventId)!);
      expect(results).toContain(stubMap.get(stale2.eventId)!);
      expect(results.join("\n")).not.toContain("STALE1-row-1:");
      expect(results.join("\n")).not.toContain("STALE2-row-1:");
      expect(results).toContain(staleSmall.text);
      for (const tailRec of tailRecords) expect(results).toContain(tailRec.text);
      expect(results).toContain(inFlightRec.text);
    }

    // --- Part B: Step 3 (in-flight stubbing keeping newest stubKeepRecent and < minTokens verbatim) ---
    {
      const { log, store, writer } = openWorkspace("sess-step3");
      const largeBody = (tag: string) =>
        Array.from({ length: 120 }, (_, i) => `${tag}-row-${i + 1}: ${"content-".repeat(7)}`).join("\n");

      // Completed turn 1 folded in Step 2
      const t1 = (await writer.startTurn("Completed turn 1 " + "z".repeat(1200)))!;
      await writer.assistant(t1, { role: "assistant", content: "Turn 1 complete." });

      // In-flight turn 2 with 6 results: 2 older large, 1 older small, and 3 recent large (keepRecent=3)
      const t2 = (await writer.startTurn("In-flight turn 2"))!;
      const ifOld1 = await appendShapedResult(log, store, writer, t2, "if-old-1", largeBody("IFOLD1"), {
        inlineThresholdTokens: 50,
        maxLines: 30,
        headLines: 15,
        tailLines: 15,
      });
      const ifSmall = await appendShapedResult(log, store, writer, t2, "if-small", "tiny-in-flight-ok");
      const ifOld2 = await appendShapedResult(log, store, writer, t2, "if-old-2", largeBody("IFOLD2"), {
        inlineThresholdTokens: 50,
        maxLines: 30,
        headLines: 15,
        tailLines: 15,
      });
      const ifKeep1 = await appendShapedResult(log, store, writer, t2, "if-keep-1", "KEEP_RECENT_1_" + "k".repeat(400));
      const ifKeep2 = await appendShapedResult(log, store, writer, t2, "if-keep-2", "KEEP_RECENT_2_" + "k".repeat(400));
      const ifKeep3 = await appendShapedResult(log, store, writer, t2, "if-keep-3", "KEEP_RECENT_3_" + "k".repeat(400));

      const events = log.readAll({ includeInternal: true });
      const restored = restoreFrozenState(events);
      if (!restored.ok) throw restored.error;
      const mat0 = materializeHistory(restored.state, events);
      if (!mat0.ok) throw mat0.error;
      const initialFill = requestFill({}, mat0.messages, 100_000, { effectiveMaxTokens: 200 });
      if (!initialFill.ok) throw new Error(initialFill.error.message);
      const usableTokens = Math.floor(initialFill.fill.inputTokens / 0.9);

      const outcome = await runCompaction({
        log,
        liveRequest: { model: "claude-sonnet-4-20250514", provider: "anthropic", messages: [] },
        contextWindowTokens: usableTokens + 200,
        options: { effectiveMaxTokens: 200, tailTurns: 4, stubMinTokens: 200, stubKeepRecent: 3 },
        planStubs: planToolResultStubs,
        runSummary: async () => ({
          text: validSummary("Folded turn 1."),
          finishReason: "stop",
          usage: { input: 100, output: 40, totalTokens: 140 },
          toolCalls: [],
        }),
      });

      expect(outcome.status).toBe("rewritten");
      if (outcome.status !== "rewritten") throw new Error(JSON.stringify(outcome));
      expect(outcome.fill.fits).toBe(true);

      const stubMap = new Map(outcome.state.stubSet.map((s) => [s.eventId, s.stubText]));
      expect([...stubMap.keys()].sort()).toEqual([ifOld1.eventId, ifOld2.eventId].sort());
      expect(stubMap.get(ifOld1.eventId)).toContain(ifOld1.eventId);
      expect(stubMap.get(ifOld1.eventId)).toContain(ifOld1.artifactId!);
      expect(stubMap.get(ifOld1.eventId)!.length).toBeLessThan(ifOld1.text.length);
      expect(stubMap.get(ifOld2.eventId)).toContain(ifOld2.eventId);
      expect(stubMap.get(ifOld2.eventId)).toContain(ifOld2.artifactId!);
      expect(stubMap.get(ifOld2.eventId)!.length).toBeLessThan(ifOld2.text.length);

      const mat = materializeHistory(outcome.state, log);
      expect(mat.ok).toBe(true);
      if (!mat.ok) throw mat.error;
      const results = mat.messages
        .filter((m): m is Extract<typeof m, { role: "tool_result" }> => m.role === "tool_result")
        .map((m) => m.result);
      expect(results).toContain(stubMap.get(ifOld1.eventId)!);
      expect(results).toContain(stubMap.get(ifOld2.eventId)!);
      expect(results.join("\n")).not.toContain("IFOLD1-row-1:");
      expect(results.join("\n")).not.toContain("IFOLD2-row-1:");
      expect(results).toContain(ifSmall.text);
      expect(results).toContain(ifKeep1.text);
      expect(results).toContain(ifKeep2.text);
      expect(results).toContain(ifKeep3.text);
    }

    // --- Part C: Never return a stub longer in chars/bytes than the original or below minTokens ---
    {
      const emojiText = "🧪".repeat(45);
      const shortEmojiCandidate: StubCandidate = {
        eventId: "ev-short-emoji",
        turnId: 1,
        callId: "call-short-emoji",
        toolName: "shell",
        text: emojiText,
        isError: false,
        estimatedTokens: estimateTokens(emojiText),
      };
      expect(shortEmojiCandidate.estimatedTokens).toBe(45);
      expect(
        planToolResultStubs([shortEmojiCandidate], { phase: "stale", minTokens: 40, keepRecent: 3 }),
      ).toEqual([]);
      expect(
        planToolResultStubs([shortEmojiCandidate], { phase: "stale", minTokens: 100, keepRecent: 3 }),
      ).toEqual([]);
    }
  });

  test("budgets elision marker into maxBytes and maxLines+1 across long-line, multibyte, and 360 seeded randomized inputs", () => {
    // Explicit reproductions: long-line and multibyte tiny overflows at default 8192-byte cap
    const reproductions = [
      "x".repeat(DEFAULT_SHAPE_MAX_BYTES + 1),
      "x".repeat(DEFAULT_SHAPE_MAX_BYTES + 128),
      "x".repeat(DEFAULT_SHAPE_MAX_BYTES + 4096),
      "雪🧪🚀漢".repeat(1000), // > 8192 UTF-8 bytes on a single line
      Array.from({ length: 85 }, (_, i) => `line-${i}: ${"字".repeat(40)}`).join("\n"),
    ];

    for (const raw of reproductions) {
      const res = shapeToolOutput({
        toolName: "shell",
        text: raw,
        storeArtifact: () => "art_repro123456",
      });
      expect(res.shaped).toBe(true);
      expect(Buffer.byteLength(res.text, "utf8")).toBeLessThanOrEqual(DEFAULT_SHAPE_MAX_BYTES);
      expect(res.text.split("\n").length).toBeLessThanOrEqual(DEFAULT_SHAPE_MAX_LINES + 1);
      expect(Buffer.from(res.text, "utf8").toString("utf8")).toBe(res.text);
      expect(Buffer.byteLength(res.text, "utf8")).toBeLessThan(Buffer.byteLength(raw, "utf8"));
      expect(res.text.length).toBeLessThan(raw.length);
      const again = shapeToolOutput({ toolName: "shell", text: res.text });
      expect(again.shaped).toBe(false);
      expect(again.text).toBe(res.text);
    }

    // Also test line cap when head+tail lines from rawText could exceed maxLines + 1
    const mixedLineRaw = [
      ...Array.from({ length: 30 }, (_, i) => `short-${i}`),
      "long-middle-" + "m".repeat(3000),
      ...Array.from({ length: 30 }, (_, i) => `tail-${i}`),
    ].join("\n");
    const mixedRes = shapeToolOutput({
      toolName: "shell",
      text: mixedLineRaw,
      storeArtifact: () => "art_mixed123456",
      options: { inlineThresholdTokens: 50, maxLines: 20, headLines: 10, tailLines: 10, maxBytes: 1024 },
    });
    expect(mixedRes.shaped).toBe(true);
    expect(Buffer.byteLength(mixedRes.text, "utf8")).toBeLessThanOrEqual(1024);
    expect(mixedRes.text.split("\n").length).toBeLessThanOrEqual(21);

    // Deterministic PRNG (Mulberry32)
    let state = 0x5eed7654;
    const rand = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const randInt = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

    const multibytePool = ["a", "b", " ", "\t", "雪", "漢", "あ", "한", "🧪", "🚀", "👨‍👩‍👧‍👦", "é"];
    const maxBytesChoices = [512, 1024, 2048, 8192];
    const maxLinesChoices = [10, 20, 80];

    let shapedCount = 0;
    for (let i = 0; i < 360; i++) {
      const maxBytes = maxBytesChoices[i % maxBytesChoices.length]!;
      const maxLines = maxLinesChoices[i % maxLinesChoices.length]!;
      const category = i % 4;
      let raw = "";

      if (category === 0) {
        // Long single or few lines
        const lineCount = randInt(1, 5);
        const targetBytes = maxBytes + randInt(50, maxBytes * 2);
        const perLine = Math.ceil(targetBytes / lineCount);
        raw = Array.from({ length: lineCount }, () => "L".repeat(perLine)).join("\n");
      } else if (category === 1) {
        // Many short lines
        const lineCount = maxLines + randInt(5, 160);
        raw = Array.from({ length: lineCount }, (_, idx) => `ln${idx}:${"x".repeat(randInt(10, 40))}`).join("\n");
      } else if (category === 2) {
        // Emoji / CJK / mixed multibyte lines
        const lineCount = randInt(1, maxLines + 40);
        const charsPerLine = lineCount === 1 ? randInt(300, 3000) : randInt(20, 140);
        raw = Array.from({ length: lineCount }, () =>
          Array.from({ length: charsPerLine }, () => multibytePool[randInt(0, multibytePool.length - 1)]!).join(""),
        ).join("\n");
      } else {
        // Tiny overflows just over maxBytes or maxLines
        if (i % 8 === 3) {
          const lineCount = maxLines + randInt(1, 3);
          raw = Array.from({ length: lineCount }, (_, idx) => `tiny-${idx}-${"k".repeat(40)}`).join("\n");
        } else {
          const overflow = randInt(1, 128);
          const pad = i % 2 === 0 ? "z" : "漢";
          const byteSize = Buffer.byteLength(pad, "utf8");
          raw = pad.repeat(Math.ceil((maxBytes + overflow) / byteSize));
        }
      }

      const withArtifact = i % 3 !== 0;
      let storeCalls = 0;
      const res = shapeToolOutput({
        toolName: "shell",
        text: raw,
        storeArtifact: () => {
          storeCalls++;
          return withArtifact ? `art_${String(i).padStart(12, "0")}` : null;
        },
        options: {
          inlineThresholdTokens: 50,
          maxBytes,
          headBytes: Math.floor(maxBytes / 2),
          tailBytes: maxBytes - Math.floor(maxBytes / 2),
          maxLines,
          headLines: Math.floor(maxLines / 2),
          tailLines: maxLines - Math.floor(maxLines / 2),
        },
      });

      const rawBytes = Buffer.byteLength(raw, "utf8");
      const resBytes = Buffer.byteLength(res.text, "utf8");
      expect(Buffer.from(res.text, "utf8").toString("utf8")).toBe(res.text);
      expect(resBytes).toBeLessThanOrEqual(rawBytes);
      expect(res.text.length).toBeLessThanOrEqual(raw.length);

      if (res.shaped) {
        shapedCount++;
        expect(resBytes).toBeLessThanOrEqual(maxBytes);
        expect(res.text.split("\n").length).toBeLessThanOrEqual(maxLines + 1);
        expect(resBytes).toBeLessThan(rawBytes);
        expect(res.text.length).toBeLessThan(raw.length);

        const callsBefore = storeCalls;
        const again = shapeToolOutput({
          toolName: "shell",
          text: res.text,
          storeArtifact: () => {
            storeCalls++;
            return "art_never_again";
          },
          options: { inlineThresholdTokens: 10, maxBytes, maxLines },
        });
        expect(again.shaped).toBe(false);
        expect(again.text).toBe(res.text);
        expect(storeCalls).toBe(callsBefore);
      }
    }
    expect(shapedCount).toBeGreaterThan(250);
  });
});
