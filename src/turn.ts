import { stream as piStream, type Message } from "@earendil-works/pi-ai";
import { appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import type { Session } from "./session.js";
import type { CompileMetrics } from "./compiler.js";
import { compileClassicWithMetrics } from "./compile-classic.js";
import {
  compileEngineWithMetrics,
  resolveContextEngineConfig,
} from "./context-engine/index.js";
import { buildSkillMetadataCatalog } from "./skills/index.js";
import { createAllTools, describeTools } from "./tools/index.js";
import { createProvider, resolveModel } from "./llm.js";
import {
  formatCompactionBanner,
  maybeAutoCompactClassic,
} from "./auto-compact.js";
import type { ContextEngine } from "./context-engine/index.js";
import { TurnRecorder } from "./context-engine/turn-recorder.js";
import { TurnAbortedError } from "./turn-control.js";
import type { TurnUiSink } from "./ui-events.js";
import { createDefaultTurnSink } from "./ui-events.js";
import { printDebug, printMemoryBanner } from "./ui.js";

export async function runTurn(
  session: Session,
  userInput: string,
  modelOverride?: string,
  options?: {
    signal?: AbortSignal;
    sink?: TurnUiSink;
  }
): Promise<string> {
  /* Always have a sink — default routes to legacy stdout/stderr helpers. */
  const s = options?.sink ?? createDefaultTurnSink();
  const successfulToolResult = (result: unknown, isError: boolean): boolean => {
    if (isError) return false;
    if (result && typeof result === "object" && "ok" in result) {
      return (result as { ok?: unknown }).ok !== false;
    }
    return true;
  };

  const turnRecorder = new TurnRecorder(userInput);
  const stateBeforeTurn = session.contextEngine?.captureStateSnapshot(
    session.stateGraph,
  );

  // 1. Append user_message
  session.eventLog.append({
    kind: "user_message",
    actor: "user",
    payload: { text: userInput },
  });
  session.setLastUserInput(userInput);

  // 1b. Auto-hydrate peripheral objects matching user query keywords (engine mode only)
  const contextEngineEnabled =
    session.isContextEngineEnabled?.() ?? session.config.context_engine?.enabled ?? false;
  const useEngineCompiler = contextEngineEnabled && !!session.contextEngine;
  const classicMode = !useEngineCompiler;

  if (contextEngineEnabled && !session.contextEngine && session.debug) {
    s.onDebug?.("context engine unavailable — falling back to classic compiler");
  }

  let autoHydrated: string[] = [];
  if (!classicMode) {
    autoHydrated = session.stateGraph.autoHydrate(userInput);
    if (autoHydrated.length > 0) {
      for (const id of autoHydrated) {
        const obj = session.stateGraph.get(id)!;
        session.eventLog.append({
          kind: "context_action",
          actor: "kernel",
          payload: {
            action: "setTier",
            id,
            tier: "active",
            lastTouched: obj.lastTouched,
            reason: "auto_hydrate",
          },
        });
      }
      if (session.debug) {
        s.onDebug?.(`auto-hydrated ${autoHydrated.length} object(s): ${autoHydrated.join(", ")}`);
      }
    }
  }

  // 2. Build tools
  const tools = createAllTools({
    eventLog: session.eventLog,
    stateGraph: session.stateGraph,
    memoryStore: session.memoryStore,
    memoryEnabled: session.memoryEnabled,
    incognito: session.isIncognito(),
    contextEngine: session.contextEngine,
    classicMode,
    cwd: session.cwd,
    sandbox: session.config.shell,
    editConfirm: session.config.edit?.confirm,
    getCurrentTurn: () => session.getTurnCount(),
    searchCode: session.config.search_code,
  });

  const modelName = modelOverride ?? session.config.llm.model;
  const contextWindowTokens = await session.ensureModelContextWindow(modelName);
  const reservedOutputTokens = session.config.compiler.reserved_output_tokens ?? 0;

  // 2b. Match skills against user input (engine mode only)
  const tokenBudget = session.config.compiler.token_budget;
  if (!classicMode) {
    session.skillRuntime?.setBudgetBase(tokenBudget);
    session.skillRuntime?.processUserInput(userInput);
  }

  // 3. Compile prompt (system only, user input passed as message)
  const recentEvents = session.eventLog.readLastUncompressed(
    session.config.compiler.recent_turns
  );
  const toolDescs = describeTools({ contextEngineEnabled, classicMode });

  const skillsSection = classicMode
    ? buildSkillMetadataCatalog(session.skills) || null
    : session.skillRuntime?.buildPromptSection(tokenBudget) ?? null;
  const agentsBudgetRatio =
    session.config.compiler.agents_budget_ratio ?? session.config.compiler.skills_budget_ratio;

  const engineConfig = resolveContextEngineConfig(session.config);
  const checkpointSection =
    contextEngineEnabled && session.contextEngine
      ? session.contextEngine.renderCheckpointSection()
      : null;

  const compileInput = {
    stateGraph: session.stateGraph,
    memoryDigest: session.digest,
    recentEvents,
    userInput,
    toolSchemas: toolDescs,
    cwd: session.cwd,
    sessionId: session.id,
    tokenBudget,
    recentTurnsTokenBudget: session.config.compiler.recent_turns_token_budget,
    agentsContext: session.agentsContext,
    skillsPromptSection: skillsSection,
    checkpointSection,
    memoriesBudgetRatio: session.config.compiler.memories_budget_ratio,
    agentsBudgetRatio,
    skillsSectionBudgetRatio: session.config.skills.max_token_budget_ratio,
    reservedOutputTokens: session.config.compiler.reserved_output_tokens,
  };

  let compiledPrompt: string;
  let promptMetrics: CompileMetrics;

  if (useEngineCompiler) {
    const engineResult = compileEngineWithMetrics({
      ...compileInput,
      currentTurn: session.getTurnCount(),
      turnRecords: session.contextEngine!.ledger.list(),
      activityEntries: session.contextEngine!.getRecentActivity(),
      engineConfig,
      contextWindowTokens,
    });
    compiledPrompt = engineResult.prompt;
    promptMetrics = engineResult.metrics;
    session.setLastCompileScoreRecords(
      engineResult.scoreRecords,
      engineResult.pressureMode,
      engineResult.pressureRatio,
    );
    session.contextEngine!.recordCompileTelemetry({
      turn: session.getTurnCount(),
      pressureMode: engineResult.pressureMode,
      excludedScoredUnits: engineResult.excludedScoredUnits,
    });
    if (session.debug && engineResult.scoreRecords.length > 0) {
      const scoresPath = join(session.promptDir, "scores.jsonl");
      if (!existsSync(session.promptDir)) {
        mkdirSync(session.promptDir, { recursive: true });
      }
      appendFileSync(
        scoresPath,
        engineResult.scoreRecords.map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
    }
  } else {
    let classicResult = compileClassicWithMetrics({
      cwd: session.cwd,
      sessionId: session.id,
      toolSchemas: toolDescs,
      agentsContext: session.agentsContext,
      projectContext: session.projectContext,
      skillsCatalog: skillsSection,
      memoryDigest: session.digest,
      events: session.eventLog.readAllUncompressed(),
      userInput,
    });
    compiledPrompt = classicResult.prompt;
    promptMetrics = classicResult.metrics;

    const compaction = await maybeAutoCompactClassic(
      session,
      promptMetrics.totalTokens,
      modelName,
    );
    const compactionBanner = formatCompactionBanner(compaction);
    if (compactionBanner) {
      s.onDebug?.(compactionBanner);
      if (!session.debug) printDebug(compactionBanner);
    }
    if (compaction.compacted) {
      classicResult = compileClassicWithMetrics({
        cwd: session.cwd,
        sessionId: session.id,
        toolSchemas: toolDescs,
        agentsContext: session.agentsContext,
        projectContext: session.projectContext,
        skillsCatalog: skillsSection,
        memoryDigest: session.digest,
        events: session.eventLog.readAllUncompressed(),
        userInput,
      });
      compiledPrompt = classicResult.prompt;
      promptMetrics = classicResult.metrics;
    }

    session.setLastCompileScoreRecords([], "normal", 0);
  }

  session.setLastCompileMetrics(promptMetrics);

  // Track input tokens
  session.recordInputTokens(promptMetrics.totalTokens);

  if (session.debug) {
    const turnNum = session.getTurnCount() + 1;
    const promptDir = session.promptDir;
    if (!existsSync(promptDir)) mkdirSync(promptDir, { recursive: true });
    const promptFile = join(promptDir, `turn-${String(turnNum).padStart(3, "0")}.md`);
    writeFileSync(promptFile, compiledPrompt, "utf-8");
    s.onDebug?.(`prompt saved → ${promptFile}`);
  }

  // 4. Create LLM provider and model
  const provider = createProvider(session.config.llm, contextWindowTokens);
  const model = provider(resolveModel(modelName));

  // 5. Stream response
  let fullResponse = "";
  let stepIndex = 0;
  const history: Message[] = [
    {
      role: "user",
      content: userInput,
      timestamp: Date.now(),
    },
  ];
  const maxSteps = 25;
  let interrupted = false;

  for (let step = 0; step < maxSteps; step++) {
    if (options?.signal?.aborted) {
      interrupted = true;
      break;
    }

    const piTools = Object.entries(tools).map(([name, def]) => ({
      name,
      description: String((def as any).description ?? ""),
      parameters: normalizeToolParameters((def as any).parameters),
    }));

    const modelOptions = {
      ...((model as any).__piOptions ?? {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    };
    const stream = piStream(
      model as any,
      {
        systemPrompt: compiledPrompt,
        messages: history,
        tools: piTools,
      },
      modelOptions
    );

    const pendingToolCalls: Array<{
      toolName: string;
      args: Record<string, unknown>;
      toolCallId: string;
    }> = [];
    let finalReason: "stop" | "length" | "toolUse" | "error" | "aborted" =
      "stop";
    let finalMessage: Message | null = null;

    for await (const event of stream) {
      if (options?.signal?.aborted) {
        interrupted = true;
        break;
      }
      if (event.type === "text_delta" && typeof event.delta === "string") {
        s.onTextDelta?.(event.delta);
        fullResponse += event.delta;
      }
      if (event.type === "thinking_delta" && typeof event.delta === "string") {
        s.onThinkingDelta?.(event.delta);
      }
      if (event.type === "toolcall_end") {
        pendingToolCalls.push({
          toolName: event.toolCall.name,
          args: (event.toolCall.arguments ?? {}) as Record<string, unknown>,
          toolCallId: event.toolCall.id,
        });
      }
      if (event.type === "done") {
        finalReason = event.reason;
        finalMessage = event.message as unknown as Message;
      }
      if (event.type === "error") {
        finalReason = event.reason;
        finalMessage = event.error as unknown as Message;
        if (finalReason === "aborted") {
          interrupted = true;
          break;
        }
      }
    }

    if (interrupted) break;

    if (finalMessage) {
      history.push(finalMessage);
    }

    if (!pendingToolCalls.length || finalReason !== "toolUse") {
      break;
    }

    const toolResults: Array<{ toolName: string; result: unknown }> = [];
    const recalledEntryIdsThisTurn = new Set<string>();
    let executionHydrated = false;

    // Notify caller that tool calls are about to execute (e.g. close thinking block)
    s.onToolCallsStart?.();

    for (const tc of pendingToolCalls) {
      if (options?.signal?.aborted) {
        interrupted = true;
        break;
      }

      session.eventLog.append({
        kind: "tool_call",
        actor: "tool",
        payload: { tool: tc.toolName, args: tc.args },
      });

      if (!session.debug) s.onSpinnerStart?.(tc.toolName);

      const toolDef = (tools as Record<string, any>)[tc.toolName];
      let result: unknown;
      let isError = false;

      if (!executionHydrated && !classicMode) {
        session.skillRuntime?.hydrateExecutionForHotSkills();
        executionHydrated = true;
      }

      if (!toolDef || typeof toolDef.execute !== "function") {
        isError = true;
        result = { ok: false, error: `Unknown tool: ${tc.toolName}` };
      } else {
        try {
          result = await toolDef.execute(tc.args);
        } catch (err: any) {
          isError = true;
          result = { ok: false, error: err?.message ?? "Tool execution failed" };
        }
      }

      if (isError && !classicMode) {
        session.skillRuntime?.hydrateRecoveryForHotSkills();
      }

      if (tc.toolName === "recall" && successfulToolResult(result, isError)) {
        const entries = (result as { entries?: Array<{ id?: string }> }).entries;
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (typeof entry?.id === "string" && entry.id) {
              recalledEntryIdsThisTurn.add(entry.id);
            }
          }
        }
      } else if (
        tc.toolName !== "recall" &&
        successfulToolResult(result, isError) &&
        recalledEntryIdsThisTurn.size > 0
      ) {
        session.memoryStore?.reinforceFromSuccessfulToolOutcome(
          Array.from(recalledEntryIdsThisTurn),
        );
      }

      if (!session.debug) {
        s.onSpinnerStop?.();
        s.onToolCall?.(tc.toolName, tc.args);
      }

      toolResults.push({ toolName: tc.toolName, result });

      let promptResultText = toolResultRawText(result);
      let artifactId: string | undefined;
      if (session.contextEngine) {
        const ingested = session.contextEngine.ingestToolResult({
          sourceTool: tc.toolName,
          command: toolCommandFromArgs(tc.toolName, tc.args as Record<string, unknown>),
          rawText: promptResultText,
          createdTurn: session.getTurnCount(),
        });
        promptResultText = ingested.promptText;
        artifactId = ingested.artifactId;
      }

      turnRecorder.recordToolCall({
        tool: tc.toolName,
        args: tc.args as Record<string, unknown>,
        result,
        isError,
        artifactId,
      });

      history.push({
        role: "toolResult",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        content: [{ type: "text", text: promptResultText }],
        isError,
        timestamp: Date.now(),
      });

      session.eventLog.append({
        kind: "tool_result",
        actor: "tool",
        payload: { tool: tc.toolName, result },
      });

      // Notify UI sink of tool result for distinct rendering (e.g. TUI)
      s.onToolResult?.(tc.toolName, promptResultText);

      if (options?.signal?.aborted) {
        interrupted = true;
        break;
      }
    }

    if (interrupted) break;

    stepIndex++;
    if (session.debug) {
      s.onDebugBlock?.(stepIndex, pendingToolCalls, toolResults);
    }
  }

  if (interrupted) {
    return finalizeInterruptedTurn(
      session,
      fullResponse,
      autoHydrated.length,
      promptMetrics.totalTokens,
      turnRecorder,
      userInput,
      stateBeforeTurn,
      classicMode,
      s,
    );
  }

  if (fullResponse && !fullResponse.endsWith("\n")) {
    s.onNewline?.();
    fullResponse += "\n";
  }

  if (!fullResponse.trim()) {
    const fallback =
      "[no response from model — try again or switch models with /model]";
    s.onFallback?.(fallback);
    fullResponse = fallback;
  }

  // 6. Append agent_message
  session.eventLog.append({
    kind: "agent_message",
    actor: "agent",
    payload: { text: fullResponse },
  });

  // Track output tokens (estimate from response)
  const outputTokens = estimateTokens(fullResponse);
  session.recordOutputTokens(outputTokens);

  // 6b. Backfill deferred distillations and persist ledger + turn digest
  if (session.contextEngine && stateBeforeTurn) {
    await session.contextEngine.flushDeferredDistillation();
    const turnRecord = turnRecorder.toRecord(
      fullResponse,
      session.getTurnCount(),
      promptMetrics.totalTokens + outputTokens,
    );
    session.contextEngine.appendTurn(turnRecord);
    session.contextEngine.processTurnExtraction({
      userMessage: userInput,
      record: turnRecord,
      stateBefore: stateBeforeTurn,
      stateGraph: session.stateGraph,
    });
  }

  // 7. Increment turn and run tier management (engine mode only)
  session.incrementTurn();
  if (!classicMode) {
    applyTierManagement(session);
    session.skillRuntime?.endTurn();
    flushSkillTelemetry(session);
  }

  // 8. Memory banner — count recall calls & hits from this turn's events
  const stats = computeMemoryStats(session, autoHydrated.length, promptMetrics.totalTokens, outputTokens);
  s.onMemoryBanner?.(stats);

  return fullResponse;
}

function finalizeInterruptedTurn(
  session: Session,
  partialResponse: string,
  autoHydrated: number,
  promptTokens: number,
  turnRecorder: TurnRecorder,
  userInput: string,
  stateBeforeTurn: ReturnType<ContextEngine["captureStateSnapshot"]> | undefined,
  classicMode: boolean,
  sink?: TurnUiSink
): never {
  const trimmed = partialResponse.trim();
  const messageText = trimmed
    ? `${trimmed}\n\n[interrupted]`
    : "[interrupted]";

  session.eventLog.append({
    kind: "system_note",
    actor: "kernel",
    payload: { type: "turn_interrupted", partial: trimmed.length > 0 },
  });

  session.eventLog.append({
    kind: "agent_message",
    actor: "agent",
    payload: { text: messageText },
  });

  if (session.contextEngine && stateBeforeTurn) {
    void session.contextEngine.flushDeferredDistillation();
    const turnRecord = turnRecorder.toRecord(
      messageText,
      session.getTurnCount(),
      promptTokens + estimateTokens(trimmed),
    );
    session.contextEngine.appendTurn(turnRecord);
    session.contextEngine.processTurnExtraction({
      userMessage: userInput,
      record: turnRecord,
      stateBefore: stateBeforeTurn,
      stateGraph: session.stateGraph,
    });
  }

  session.incrementTurn();
  if (!classicMode) {
    applyTierManagement(session);
    session.skillRuntime?.endTurn();
    flushSkillTelemetry(session);
  }

  const stats = computeMemoryStats(session, autoHydrated, promptTokens, estimateTokens(trimmed));
  if (sink) sink.onMemoryBanner?.(stats);
  else printMemoryBanner(stats);

  throw new TurnAbortedError(trimmed);
}

function flushSkillTelemetry(session: Session): void {
  const events = session.skillRuntime?.drainEvents();
  if (!events?.length) return;

  for (const event of events) {
    session.eventLog.append({
      kind: "system_note",
      actor: "kernel",
      payload: { type: "skill_telemetry", event },
    });
  }
}

/**
 * Heuristic for estimating output tokens from response text length.
 * Note: this is a rough estimate that degrades for non-ASCII text.
 * Ideally we'd get `usage` from the provider directly in the future.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function isZodSchema(schema: unknown): schema is ZodTypeAny {
  return !!schema && typeof schema === "object" && "_def" in (schema as Record<string, unknown>);
}

export function normalizeToolParameters(schema: unknown): Record<string, unknown> {
  if (isZodSchema(schema)) {
    const json = zodToJsonSchema(schema, {
      $refStrategy: "none",
      target: "jsonSchema7",
    }) as Record<string, unknown>;
    delete json.$schema;
    delete json.$ref;
    delete json.definitions;
    return json;
  }

  return {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
}

export function applyTierManagement(session: Session): void {
  const { idle_soft_after_turns, idle_hard_after_turns } =
    session.config.tiers;
  const sg = session.stateGraph;
  const currentTurn = sg.getTurnCount();

  for (const obj of sg.getActive()) {
    const touchedTurn = sg.getTouchedTurn(obj.id);
    const idleTurns = currentTurn - touchedTurn;
    if (idleTurns >= idle_hard_after_turns) {
      sg.setTier(obj.id, "hard");
    } else if (idleTurns >= idle_soft_after_turns) {
      sg.setTier(obj.id, "soft");
    }
  }

  for (const obj of sg.getPeripheral()) {
    if (obj.tier !== "soft") continue;
    const touchedTurn = sg.getTouchedTurn(obj.id);
    const idleTurns = currentTurn - touchedTurn;
    if (idleTurns >= idle_hard_after_turns) {
      sg.setTier(obj.id, "hard");
    }
  }
}

export function computeMemoryStats(
  session: Session,
  autoHydrated: number,
  promptTokens?: number,
  outputTokens?: number
): {
  activeState: number;
  totalState: number;
  digestLen: number;
  recallCalls: number;
  recallHits: number;
  autoHydrated: number;
  promptTokens: number;
  outputTokens: number;
} {
  const memStats = session.getMemoryStats();
  const recentEvents = session.eventLog.readLast(50);
  let recallCalls = 0;
  let recallHits = 0;
  for (const ev of recentEvents) {
    if (ev.kind === "system_note" && (ev.payload.type as string) === "memory_recall") {
      recallCalls++;
      recallHits += (ev.payload.hits as number) ?? 0;
    }
  }
  return {
    activeState: memStats.active,
    totalState: memStats.total,
    digestLen: session.digest?.length ?? 0,
    recallCalls,
    recallHits,
    autoHydrated,
    promptTokens: promptTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  };
}

function toolResultRawText(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

function toolCommandFromArgs(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.query === "string") return args.query;
  if (toolName === "shell" && typeof args.command === "string") return args.command;
  return undefined;
}
