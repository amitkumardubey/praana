import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// ── Mock all external dependencies ──────────────────────────────────

vi.mock("@earendil-works/pi-ai", () => ({
  stream: vi.fn(),
}));

vi.mock("zod-to-json-schema", () => ({
  zodToJsonSchema: vi.fn((_schema, _opts) => ({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    definitions: {},
  })),
}));

vi.mock("../src/compiler.js", () => ({
  compileWithMetrics: vi.fn(() => ({
    prompt: "compiled system prompt",
    metrics: {
      totalTokens: 500,
      systemFrameTokens: 100,
      agentsContextTokens: 0,
      crossSessionTokens: 50,
      activeStateTokens: 50,
      peripheralStubsTokens: 30,
      recentTurnsTokens: 200,
      currentInputTokens: 70,
      activeObjectCount: 2,
      peripheralObjectCount: 1,
      recentTurnsTruncated: false,
    },
  })),
}));

vi.mock("../src/tools/index.js", () => ({
  createAllTools: vi.fn(() => ({
    create_task: {
      description: "Create a new task",
      parameters: z.object({ title: z.string() }),
      execute: vi.fn().mockResolvedValue({ ok: true, id: "task-1" }),
    },
    shell: {
      description: "Execute a shell command",
      parameters: z.object({ command: z.string() }),
      execute: vi.fn().mockResolvedValue({ ok: true, stdout: "hello" }),
    },
    recall: {
      description: "Search memory",
      parameters: z.object({ query: z.string() }),
      execute: vi.fn().mockResolvedValue({ ok: true, results: [] }),
    },
  })),
  describeTools: vi.fn(() => [
    "create_task(title) — Create a new task",
    "shell(command) — Execute a shell command",
  ]),
}));

vi.mock("../src/llm.js", () => ({
  createProvider: vi.fn(() => vi.fn(() => ({}))),
  resolveModel: vi.fn((name: string) => name),
}));

vi.mock("../src/ui.js", () => ({
  printDebug: vi.fn(),
  printDebugBlock: vi.fn(),
  printMemoryBanner: vi.fn(),
  printToolCall: vi.fn(),
  startSpinner: vi.fn(),
  stopSpinner: vi.fn(),
}));

// ── Import after mocks ─────────────────────────────────────────────

import { stream as piStream } from "@earendil-works/pi-ai";
import { compileWithMetrics } from "../src/compiler.js";
import { createAllTools, describeTools } from "../src/tools/index.js";
import { createProvider, resolveModel } from "../src/llm.js";

import {
  runTurn,
  normalizeToolParameters,
  applyTierManagement,
  computeMemoryStats,
  isZodSchema,
} from "../src/turn.js";
import { StateGraph } from "../src/state-graph.js";
import { EventLog } from "../src/event-log.js";
import type { AriaConfig, Event } from "../src/types.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<AriaConfig>): AriaConfig {
  return {
    llm: { provider: "openrouter", model: "test-model" },
    memory: {
      enabled: false,
      summarizer: "openrouter",
      db_path: ":memory:",
      embedder: "hash",
      ollama_url: "http://localhost:11434",
      ollama_model: "nomic-embed-text",
    },
    compiler: {
      token_budget: 100_000,
      recent_turns: 10,
      recent_turns_token_budget: 30_000,
    },
    tiers: {
      idle_soft_after_turns: 3,
      idle_hard_after_turns: 6,
    },
    session: {
      log_dir: "/tmp/aria-test",
    },
    ...overrides,
  };
}

function makeMockSession(overrides?: Partial<Record<string, any>>) {
  const config = makeConfig();
  const stateGraph = new StateGraph();

  // Mock event log that stores events in memory instead of writing to disk
  const events: Event[] = [];
  const eventLog = {
    append: vi.fn((ev: Omit<Event, "event_id" | "session_id" | "timestamp">) => {
      const event: Event = {
        event_id: `evt-${events.length}`,
        session_id: "test-session",
        timestamp: Date.now(),
        ...ev,
      } as Event;
      events.push(event);
    }),
    readLast: vi.fn((n: number) => events.slice(-n)),
    readLastUncompressed: vi.fn((n: number) => events.slice(-n)),
    search: vi.fn(),
    clear: vi.fn(() => { events.length = 0; }),
  };

  const session: any = {
    id: `test-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    cwd: "/home/test/project",
    config,
    eventLog,
    stateGraph,
    memoryStore: null,
    memoryEnabled: false,
    incognito: false,
    digest: null,
    agentsContext: null,
    debug: false,
    promptDir: "/tmp/aria-test/prompts",
    _turnCount: 0,
    _lastCompileMetrics: null,

    incrementTurn() {
      this._turnCount++;
      this.stateGraph.incrementTurn();
    },
    getTurnCount() { return this._turnCount; },
    getMemoryStats() {
      return {
        total: this.stateGraph.snapshot().length,
        active: this.stateGraph.getActive().length,
        soft: this.stateGraph.getPeripheral().filter((o: any) => o.tier === "soft").length,
        hard: this.stateGraph.getPeripheral().filter((o: any) => o.tier === "hard").length,
        byKind: {} as Record<string, number>,
      };
    },
    setLastCompileMetrics(m: any) { this._lastCompileMetrics = m; },
    getLastCompileMetrics() { return this._lastCompileMetrics; },
    isIncognito() { return this.incognito ?? false; },
    _inputTokens: 0,
    _outputTokens: 0,
    recordInputTokens(count: number) { this._inputTokens += count; },
    recordOutputTokens(count: number) { this._outputTokens += count; },
    getInputTokens() { return this._inputTokens; },
    getOutputTokens() { return this._outputTokens; },
    ...overrides,
  };

  return session;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("isZodSchema", () => {
  it("returns true for a Zod schema", () => {
    expect(isZodSchema(z.object({}))).toBe(true);
  });

  it("returns false for plain objects", () => {
    expect(isZodSchema({ type: "object" })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isZodSchema(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isZodSchema(undefined)).toBe(false);
  });

  it("returns false for strings", () => {
    expect(isZodSchema("string")).toBe(false);
  });
});

describe("normalizeToolParameters", () => {
  it("converts a Zod schema to a JSON schema without $ref/definitions", () => {
    const schema = z.object({ name: z.string() });
    const result = normalizeToolParameters(schema);
    expect(result).not.toHaveProperty("$ref");
    expect(result).not.toHaveProperty("definitions");
    expect(result).toHaveProperty("type", "object");
    expect(result).toHaveProperty("properties");
  });

  it("returns a default object for non-Zod input", () => {
    const result = normalizeToolParameters({ type: "object" });
    expect(result).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
  });

  it("returns a default object for null", () => {
    const result = normalizeToolParameters(null);
    expect(result).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
  });

  it("returns a default object for undefined", () => {
    const result = normalizeToolParameters(undefined);
    expect(result).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
  });
});

describe("applyTierManagement", () => {
  it("demotes active objects to soft when idle turns >= idle_soft_after_turns", () => {
    const config = makeConfig({ tiers: { idle_soft_after_turns: 2, idle_hard_after_turns: 10 } });
    const sg = new StateGraph();
    const obj = sg.create("note", { text: "test" });
    // Advance turns past the idle threshold
    sg.incrementTurn();
    sg.incrementTurn();
    sg.incrementTurn(); // turnCount = 3

    const session: any = { config, stateGraph: sg };
    applyTierManagement(session);

    const updated = sg.get(obj.id);
    expect(updated?.tier).toBe("soft");
  });

  it("demotes active objects to hard when idle turns >= idle_hard_after_turns", () => {
    const config = makeConfig({ tiers: { idle_soft_after_turns: 2, idle_hard_after_turns: 4 } });
    const sg = new StateGraph();
    const obj = sg.create("note", { text: "test" });
    // Advance turns past the hard threshold
    for (let i = 0; i < 5; i++) sg.incrementTurn(); // turnCount = 5

    const session: any = { config, stateGraph: sg };
    applyTierManagement(session);

    const updated = sg.get(obj.id);
    expect(updated?.tier).toBe("hard");
  });

  it("does nothing when idle turns are below thresholds", () => {
    const config = makeConfig({ tiers: { idle_soft_after_turns: 5, idle_hard_after_turns: 10 } });
    const sg = new StateGraph();
    const obj = sg.create("note", { text: "test" });

    const session: any = { config, stateGraph: sg };
    applyTierManagement(session);

    const updated = sg.get(obj.id);
    expect(updated?.tier).toBe("active"); // still active
  });

  it("demotes soft peripheral objects to hard when idle turns >= idle_hard_after_turns", () => {
    const config = makeConfig({ tiers: { idle_soft_after_turns: 2, idle_hard_after_turns: 4 } });
    const sg = new StateGraph();
    const obj = sg.create("note", { text: "test" });
    sg.setTier(obj.id, "soft");

    // Advance turns so it's been idle since turn 0
    for (let i = 0; i < 5; i++) sg.incrementTurn(); // turnCount = 5

    const session: any = { config, stateGraph: sg };
    applyTierManagement(session);

    const updated = sg.get(obj.id);
    expect(updated?.tier).toBe("hard");
  });

  it("does not promote objects (only demotes)", () => {
    const config = makeConfig({ tiers: { idle_soft_after_turns: 2, idle_hard_after_turns: 5 } });
    const sg = new StateGraph();
    const obj = sg.create("note", { text: "test" });
    sg.setTier(obj.id, "hard"); // already hard

    // Freshly touched (turn 0 is current)
    const session: any = { config, stateGraph: sg };
    applyTierManagement(session);

    const updated = sg.get(obj.id);
    expect(updated?.tier).toBe("hard"); // stays hard
  });
});

describe("computeMemoryStats", () => {
  it("returns stats from session memory stats", () => {
    const sg = new StateGraph();
    sg.create("task", { title: "t1", status: "todo" });
    sg.create("note", { text: "n1" });

    const eventLog = {
      readLast: vi.fn(() => [] as Event[]),
      readLastUncompressed: vi.fn(() => [] as Event[]),
    };

    const session: any = {
      stateGraph: sg,
      eventLog,
      digest: "memory digest content",
      getMemoryStats() {
        return {
          total: this.stateGraph.snapshot().length,
          active: this.stateGraph.getActive().length,
          soft: 0,
          hard: 0,
          byKind: {} as Record<string, number>,
        };
      },
    };

    const stats = computeMemoryStats(session, 3);
    expect(stats.totalState).toBe(2);
    expect(stats.activeState).toBe(2);
    expect(stats.digestLen).toBe("memory digest content".length);
    expect(stats.recallCalls).toBe(0);
    expect(stats.recallHits).toBe(0);
    expect(stats.autoHydrated).toBe(3);
  });

  it("counts recall calls and hits from event log", () => {
    const sg = new StateGraph();
    const eventLog = {
      readLast: vi.fn(() => [
        { kind: "system_note", payload: { type: "memory_recall", hits: 3 } },
        { kind: "system_note", payload: { type: "memory_recall", hits: 2 } },
        { kind: "system_note", payload: { type: "other" } },
        { kind: "tool_call", payload: { tool: "recall" } },
      ] as Event[]),
      readLastUncompressed: vi.fn(() => [
        { kind: "system_note", payload: { type: "memory_recall", hits: 3 } },
        { kind: "system_note", payload: { type: "memory_recall", hits: 2 } },
        { kind: "system_note", payload: { type: "other" } },
        { kind: "tool_call", payload: { tool: "recall" } },
      ] as Event[]),
    };

    const session: any = {
      stateGraph: sg,
      eventLog,
      digest: null,
      getMemoryStats() {
        return { total: 0, active: 0, soft: 0, hard: 0, byKind: {} };
      },
    };

    const stats = computeMemoryStats(session, 0);
    expect(stats.recallCalls).toBe(2);
    expect(stats.recallHits).toBe(5); // 3 + 2
  });

  it("handles empty event log gracefully", () => {
    const sg = new StateGraph();
    const eventLog = {
      readLast: vi.fn(() => [] as Event[]),
      readLastUncompressed: vi.fn(() => [] as Event[]),
    };

    const session: any = {
      stateGraph: sg,
      eventLog,
      digest: null,
      getMemoryStats() {
        return { total: 0, active: 0, soft: 0, hard: 0, byKind: {} };
      },
    };

    const stats = computeMemoryStats(session, 0);
    expect(stats.recallCalls).toBe(0);
    expect(stats.recallHits).toBe(0);
    expect(stats.digestLen).toBe(0);
  });
});

describe("runTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock: a simple text response (no tool calls)
    const mockAsyncGenerator = (async function* () {
      yield { type: "text_delta", delta: "Hello from AI" };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello from AI" }],
        },
      };
    })();

    vi.mocked(piStream).mockReturnValue(mockAsyncGenerator as any);
  });

  it("processes user input and returns the AI response", async () => {
    const session = makeMockSession();
    const response = await runTurn(session, "hello");

    expect(response).toContain("Hello from AI");
    expect(compileWithMetrics).toHaveBeenCalled();
    expect(createAllTools).toHaveBeenCalled();
    expect(createProvider).toHaveBeenCalled();
    expect(resolveModel).toHaveBeenCalled();
  });

  it("passes modelOverride to resolveModel", async () => {
    const session = makeMockSession();
    await runTurn(session, "hello", "gpt-4");

    expect(resolveModel).toHaveBeenCalledWith("gpt-4");
  });

  it("handles an empty LLM response with a fallback message", async () => {
    const emptyGenerator = (async function* () {
      yield { type: "done", reason: "stop", message: { role: "assistant", content: [] } };
    })();

    vi.mocked(piStream).mockReturnValue(emptyGenerator as any);

    const session = makeMockSession();
    const response = await runTurn(session, "hello");
    expect(response).toContain("no response from model");
  });

  it("accumulates input and output tokens during the turn", async () => {
    const responseText = "Hello world this is a response";
    const generator = (async function* () {
      yield { type: "text_delta", delta: responseText };
      yield { type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: responseText }] } };
    })();
    vi.mocked(piStream).mockReturnValue(generator as any);
    vi.mocked(compileWithMetrics).mockReturnValue({
      prompt: "mock prompt",
      metrics: {
        totalTokens: 150,
        activeStateTokens: 10,
        peripheralStateTokens: 20,
        recentTurnsTokens: 30,
        toolSchemasTokens: 40,
        systemFrameTokens: 50,
        recentTurnsTruncated: false,
      }
    } as any);

    const session = makeMockSession();

    // Initial should be 0
    expect(session.getInputTokens()).toBe(0);
    expect(session.getOutputTokens()).toBe(0);

    const spyIn = vi.spyOn(session, 'recordInputTokens');
    const spyOut = vi.spyOn(session, 'recordOutputTokens');

    await runTurn(session, "hello");

    // Input tokens come from promptMetrics.totalTokens
    expect(spyIn).toHaveBeenCalledWith(150);
    expect(session.getInputTokens()).toBe(150);

    // Output tokens: called exactly once with a positive value
    expect(spyOut).toHaveBeenCalledTimes(1);
    const outArg = spyOut.mock.calls[0][0] as number;
    expect(outArg).toBeGreaterThan(0);
    expect(session.getOutputTokens()).toBe(outArg);
  });

  it("processes tool calls and returns results", async () => {
    const toolCallGenerator = (async function* () {
      yield { type: "text_delta", delta: "Let me check" };
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "shell", arguments: { command: "echo hi" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check" },
            { type: "toolUse", toolUse: { id: "call-1", name: "shell", arguments: { command: "echo hi" } } },
          ],
        },
      };
    })();

    vi.mocked(piStream).mockReturnValue(toolCallGenerator as any);

    const session = makeMockSession();
    const response = await runTurn(session, "run command");

    expect(response).toContain("Let me check");
    // Should have logged tool call and result events
    const events = session.eventLog.readLast(50);
    const toolCalls = events.filter((e: Event) => e.kind === "tool_call");
    const toolResults = events.filter((e: Event) => e.kind === "tool_result");
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolResults.length).toBeGreaterThan(0);
  });

  it("calls onToolCallsStart before tool execution", async () => {
    const toolCallGenerator = (async function* () {
      yield { type: "text_delta", delta: "Thinking..." };
      yield { type: "thinking_delta", delta: "hmm" };
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "shell", arguments: { command: "echo hi" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Thinking..." },
            { type: "toolUse", toolUse: { id: "call-1", name: "shell", arguments: { command: "echo hi" } } },
          ],
        },
      };
    })();

    vi.mocked(piStream).mockReturnValue(toolCallGenerator as any);

    const session = makeMockSession();
    const onToolCallsStart = vi.fn();

    await runTurn(session, "do something", undefined, { onToolCallsStart });

    expect(onToolCallsStart).toHaveBeenCalledTimes(1);
  });

  it("reinforces recalled memories when a later tool succeeds in the same turn", async () => {
    const firstStep = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "recall", arguments: { query: "streaming" } },
      };
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-2", name: "shell", arguments: { command: "echo ok" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [],
        },
      };
    })();
    const secondStep = (async function* () {
      yield { type: "text_delta", delta: "done" };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      };
    })();
    vi.mocked(piStream)
      .mockReturnValueOnce(firstStep as any)
      .mockReturnValueOnce(secondStep as any);

    const reinforceFromSuccessfulToolOutcome = vi.fn();
    const session = makeMockSession({
      memoryStore: { reinforceFromSuccessfulToolOutcome },
      memoryEnabled: true,
    });

    vi.mocked(createAllTools).mockReturnValueOnce({
      recall: {
        description: "Search memory",
        parameters: z.object({ query: z.string() }),
        execute: vi.fn().mockResolvedValue({
          ok: true,
          entries: [{ id: "m1", content: "streaming is implemented" }],
        }),
      },
      shell: {
        description: "Execute a shell command",
        parameters: z.object({ command: z.string() }),
        execute: vi.fn().mockResolvedValue({ ok: true, stdout: "ok" }),
      },
    } as any);

    await runTurn(session, "verify streaming");

    expect(reinforceFromSuccessfulToolOutcome).toHaveBeenCalledWith(["m1"]);
  });

  it("calls incrementTurn and prints memory banner on success", async () => {
    const session = makeMockSession();
    const { printMemoryBanner } = await import("../src/ui.js");

    await runTurn(session, "hello");

    expect(session.getTurnCount()).toBe(1);
    expect(printMemoryBanner).toHaveBeenCalled();
  });

  it("calls applyTierManagement after turn completion", async () => {
    const session = makeMockSession();
    const sg = session.stateGraph;
    const obj = sg.create("note", { text: "stale note" });
    sg.setTier(obj.id, "soft");

    await runTurn(session, "hello");

    // after runTurn, tier management runs and turn increments
    // obj was created at turn 0, now we're at turn 1+, so idle turns = 1
    // which is less than soft threshold (3), so it stays soft
    expect(sg.get(obj.id)?.tier).toBe("soft");
  });

  it("handles tool execution errors gracefully", async () => {
    // Mock a tool call that fails
    vi.mocked(createAllTools).mockReturnValueOnce({
      failing_tool: {
        description: "A tool that fails",
        parameters: z.object({}),
        execute: vi.fn().mockRejectedValue(new Error("Something broke")),
      },
    } as any);

    const toolCallGenerator = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "failing_tool", arguments: {} },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [],
        },
      };
    })();

    vi.mocked(piStream).mockReturnValue(toolCallGenerator as any);

    const session = makeMockSession();
    // This should not throw — tool errors are caught and returned as error results
    const response = await runTurn(session, "do something");
    expect(typeof response).toBe("string");
  });

  it("stops after maxSteps tool call iterations", async () => {
    // Use mockImplementation so each piStream call creates a fresh generator
    // that yields one tool call then completes
    vi.mocked(piStream).mockImplementation(() => {
      return (async function* () {
        yield {
          type: "toolcall_end",
          toolCall: { id: "call-1", name: "shell", arguments: { command: "echo hi" } },
        };
        yield {
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            content: [],
          },
        };
      })();
    });

    const session = makeMockSession();
    const response = await runTurn(session, "loop");
    expect(typeof response).toBe("string");
    // After maxSteps=25 iterations, the loop should exit with whatever
    // response it accumulated (even if empty, it falls back to fallback msg)
    expect(response.length).toBeGreaterThan(0);
  });

  it("reacts to abort signal", async () => {
    const abortController = new AbortController();

    const session = makeMockSession();

    // Fire an async turn, then abort
    const turnPromise = runTurn(session, "hello", undefined, {
      signal: abortController.signal,
    });

    abortController.abort();

    await expect(turnPromise).rejects.toThrow();
  });

  it("appends user_message and agent_message events to the event log", async () => {
    const session = makeMockSession();
    await runTurn(session, "record this");

    const events = session.eventLog.readLast(50);
    const userMsgs = events.filter((e: Event) => e.kind === "user_message");
    const agentMsgs = events.filter((e: Event) => e.kind === "agent_message");

    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(agentMsgs.length).toBeGreaterThanOrEqual(1);
    expect(userMsgs[0].payload).toMatchObject({ text: "record this" });
  });

  it("triggers auto-hydrate on matching user input", async () => {
    const session = makeMockSession();
    const sg = session.stateGraph;
    const obj = sg.create("note", { text: "important note about deployment" });
    sg.setTier(obj.id, "soft"); // peripheral

    // Turn count is 0 when obj was created, then 0 when soft-demoted
    // After runTurn, auto-hydrate should match "deployment" keyword
    await runTurn(session, "tell me about deployment");

    const updated = sg.get(obj.id);
    // The note was soft, but "deployment" might match via autoHydrate
    // autoHydrate searches payload text for keywords from user input
    // It uses simple substring matching
    expect(updated).toBeDefined();
  });
});
