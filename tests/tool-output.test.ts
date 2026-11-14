import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { ArtifactStore } from "../src/context-engine/artifact-store.js";
import { estimateTokens } from "../src/token-estimate.js";
import {
  buildToolResultStub,
  DEFAULT_EXACT_BYTES_TOOLS,
  planToolResultStubs,
  shapeToolOutput,
} from "../src/tool-output.js";

const tempDirs: string[] = [];
const stores: ArtifactStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
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
});
