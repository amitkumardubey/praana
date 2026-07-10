import { stream as piStream, type Message } from "@earendil-works/pi-ai/compat";
import { appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { resolveDefaultSessionLogDir } from "./app-identity.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import type { Session } from "./session.js";
import type { AutoHydrateResult } from "./state-graph.js";
import type { CompileMetrics } from "./compiler.js";
import { compileClassicWithMetrics } from "./compile-classic.js";
import {
  compileEngineWithMetrics,
  resolveContextEngineConfig,
  estimateTokens,
} from "./context-engine/index.js";
import { EmbeddingCache } from "./context-engine/embedding-cache.js";
import { buildArtifactCard } from "./context-engine/summarize.js";
import { buildSkillMetadataCatalog } from "./skills/index.js";
import { createAllTools, describeTools } from "./tools/index.js";
import { createProvider, resolveModel, getReasoningEffort } from "./llm.js";
import {
  formatCompactionBanner,
  maybeAutoCompactClassic,
} from "./auto-compact.js";
import type { ContextEngine } from "./context-engine/index.js";
import { TurnRecorder } from "./context-engine/turn-recorder.js";
import { TurnAbortedError } from "./turn-control.js";
import type { TurnUiSink } from "./ui-events.js";
import { createDefaultTurnSink } from "./ui-events.js";
import {
  buildContextDisplaySnapshot,
  computeDistillerSavings,
  estimateAssistantMessageTokens,
  maxContextSnapshot,
} from "./context-display.js";
import { estimateTokens as estimateDisplayTokens } from "./token-estimate.js";
import {
  createSessionLogger,
  extractLlmErrorMessage,
  formatUserFacingLlmError,
  type LogEntry,
} from "./logger.js";
import { printDebug, printMemoryBanner } from "./ui.js";

type ProviderUsage = { input: number; output: number; totalTokens: number };

export type ProviderUsageUpdate = {
  step: ProviderUsage;
  cumulative: ProviderUsage;
  /** Latest API request input size — best proxy for context-window fill. */
  latestContextTokens: number;
};

function parseProviderUsage(message: unknown): ProviderUsage | null {
  if (typeof message !== "object" || message === null) return null;
  const usage = (message as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  if (
    Number.isFinite(u.input) &&
    Number.isFinite(u.output) &&
    Number.isFinite(u.totalTokens) &&
    (u.input as number) >= 0 &&
    (u.output as number) >= 0 &&
    (u.totalTokens as number) >= 0
  ) {
    const input = u.input as number;
    const output = u.output as number;
    const totalTokens = u.totalTokens as number;
    // Some providers / SDKs initialise a placeholder usage struct with all zeros
    // when usage metadata is unavailable in streaming mode.
    if (input === 0 && output === 0 && totalTokens === 0) return null;
    return { input, output, totalTokens };
  }
  return null;
}

function addProviderUsage(
  acc: ProviderUsage | null,
  step: ProviderUsage,
): ProviderUsage {
  if (!acc) return { ...step };
  return {
    input: acc.input + step.input,
    output: acc.output + step.output,
    totalTokens: acc.totalTokens + step.totalTokens,
  };
}

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

  let autoHydrated: AutoHydrateResult[] = [];
  if (!classicMode) {
    autoHydrated = session.stateGraph.autoHydrate(userInput);
    if (autoHydrated.length > 0) {
      for (const { id, method } of autoHydrated) {
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
            hydrate_method: method,
          },
        });
      }
      if (session.debug) {
        s.onDebug?.(`auto-hydrated ${autoHydrated.length} object(s): ${autoHydrated.map((r) => r.id).join(", ")}`);
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
    scorecard: session.scorecard,
    onScorecardFileRead: (absPath) => session.trackScorecardFileRead(absPath),
    onScorecardSkillLoad: (skillId, bodyTokens) => session.scorecard.trackSkillLoad(skillId, bodyTokens),
    classicMode,
    cwd: session.cwd,
    sandbox: session.config.shell,
    editConfirm: session.config.edit?.confirm,
    getCurrentTurn: () => session.getTurnCount(),
    searchCode: session.config.search_code,
    getAbortSignal: () => options?.signal,
    shellLiveStream: s.shellLiveStream ?? true,
    skills: session.skills ?? [],
    skillRuntime: session.skillRuntime,
    blockRepeatReads: session.config.tools?.block_repeat_reads ?? false,
    hasReadPath: (absPath) => session.scorecard.hasReadPath(absPath),
    clearReadPath: (absPath) => {
      session.scorecard.clearReadPath(absPath);
      session.contextEngine?.clearFileRead(absPath);
    },
    findFileReadArtifact: (absPath) => {
      const art = session.contextEngine?.findFileReadArtifact(absPath) ?? null;
      if (!art) return null;
      return {
        id: art.id,
        createdTurn: art.createdTurn,
        card: buildArtifactCard(
          art.id,
          art.sourceTool,
          art.command,
          art.rawTokens,
          art.summary,
        ),
      };
    },
  });

  const modelName = modelOverride ?? session.config.llm.model;
  const contextWindowTokens = await session.ensureModelContextWindow(modelName);
  const reservedOutputTokens = session.config.compiler.reserved_output_tokens ?? 0;


  const recentEvents = session.eventLog.readLastUncompressed(
    session.config.compiler.recent_turns
  );
  const toolDescs = describeTools({ contextEngineEnabled, classicMode });

  const skillsSection = buildSkillMetadataCatalog(session.skills, session.skillUsefulness ?? undefined) || null;
  const tokenBudget = session.config.compiler.token_budget;
  const agentsBudgetRatio = session.config.compiler.agents_budget_ratio;

  const engineConfig = resolveContextEngineConfig(session.config);
  const checkpoint =
    contextEngineEnabled && session.contextEngine
      ? session.contextEngine.getSessionCheckpoint() ?? undefined
      : undefined;

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
    checkpoint,
    memoriesBudgetRatio: session.config.compiler.memories_budget_ratio,
    agentsBudgetRatio,
    skillsSectionBudgetRatio: session.config.skills.max_token_budget_ratio,
    reservedOutputTokens: session.config.compiler.reserved_output_tokens,
  };

  let compiledPrompt: string;
  let promptMetrics: CompileMetrics;

  if (useEngineCompiler) {
    if (!session.embeddingCache) {
      session.embeddingCache = new EmbeddingCache();
    }
    // Pre-fetch all stored workflow patterns for injection into the compiled prompt
    // (issue #92). The compiler filters them to the classified task type internally.
    const workflowPatterns = session.contextEngine!.listAllWorkflowPatterns();
    const engineResult = await compileEngineWithMetrics({
      ...compileInput,
      currentTurn: session.getTurnCount(),
      turnRecords: session.contextEngine!.ledger.list(),
      activityEntries: session.contextEngine!.getRecentActivity(),
      engineConfig,
      contextWindowTokens,
      hydratedTexts: autoHydrated.map((r) => r.text),
      embedder: session.memoryStore?.embedder ?? null,
      embeddingCache: session.embeddingCache,
      workflowPatterns,
    });
    compiledPrompt = engineResult.prompt;
    promptMetrics = {
      ...engineResult.metrics,
      taskType: engineResult.taskType,
    };
    // Track task type for workflow pattern persistence at session end (issue #92).
    session.setLastKnownTaskType(engineResult.taskType);
    session.setLastCompileScoreRecords(
      engineResult.scoreRecords,
      engineResult.pressureMode,
      engineResult.pressureRatio,
      engineResult.weightedTokens,
      engineResult.rawPressureRatio,
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

  let turnHistoryTokens = estimateDisplayTokens(userInput);
  let turnDistillerSavings = 0;
  const contextBaseline = buildContextDisplaySnapshot({
    session,
    contextWindowTokens,
    engineMode: useEngineCompiler,
    historyTokens: turnHistoryTokens,
  });
  s.onTurnContextBaseline?.(contextBaseline);

  if (session.debug) {
    const turnNum = session.getTurnCount() + 1;
    const promptDir = session.promptDir;
    if (!existsSync(promptDir)) mkdirSync(promptDir, { recursive: true });
    const promptFile = join(promptDir, `turn-${String(turnNum).padStart(3, "0")}.md`);
    writeFileSync(promptFile, compiledPrompt, "utf-8");
    s.onDebug?.(`prompt saved → ${promptFile}`);
  }

  // 4. Create LLM provider and model
  const effectiveLlm = session.getEffectiveLlmConfig();
  const providerFn = createProvider(effectiveLlm, contextWindowTokens);
  const model = providerFn(resolveModel(modelName));

  const logger = await createSessionLogger({
    sessionId: session.id,
    sessionLogDir: session.config.session?.log_dir ?? resolveDefaultSessionLogDir(),
    debug: session.debug,
  });
  const llmLogger = logger.child("llm");
  const providerName = effectiveLlm.provider;

  // 5. Stream response
  let fullResponse = "";
  let stepIndex = 0;
  let lastStreamReason: "stop" | "length" | "toolUse" | "error" | "aborted" = "stop";
  let lastLlmErrorMessage: string | undefined;
  let providerUsage: ProviderUsage | null = null;
  let recordedProviderUsage = false;
  const history: Message[] = [
    {
      role: "user",
      content: userInput,
      timestamp: Date.now(),
    },
  ];
  const maxSteps = session.config.turn?.max_steps ?? 25;
  let interrupted = false;
  // Tracks whether any step in the turn ran a non-load_skill tool, for markResidentSkillsUsed.
  let hadNonLoadSkillTool = false;

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

    const streamReasoning = getReasoningEffort(
      model as Record<string, unknown>,
      modelName,
      providerName,
    );
    const modelOptions = {
      ...((model as any).__piOptions ?? {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      // pi-ai `stream()` expects `reasoningEffort`; `reasoning` is only for `streamSimple()`.
      ...(streamReasoning ? { reasoningEffort: streamReasoning } : {}),
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
        const stepUsage = parseProviderUsage(event.message);
        if (stepUsage) {
          recordedProviderUsage = true;
          providerUsage = addProviderUsage(providerUsage, stepUsage);
          session.recordInputTokens(stepUsage.input);
          session.recordOutputTokens(stepUsage.output);
          s.onProviderUsage?.({
            step: stepUsage,
            cumulative: providerUsage,
            latestContextTokens: stepUsage.input,
          });
        }
      }
      if (event.type === "error") {
        finalReason = event.reason;
        finalMessage = event.error as unknown as Message;
        const llmMessage = extractLlmErrorMessage(finalMessage);
        lastStreamReason = finalReason;
        lastLlmErrorMessage = llmMessage;
        if (finalReason === "aborted") {
          llmLogger.warn("LLM stream aborted", {
            code: "LLM_ABORTED",
            details: { model: modelName, provider: providerName, message: llmMessage },
          });
          interrupted = true;
          break;
        }
        llmLogger.error("LLM stream error", {
          code: "LLM_STREAM_ERROR",
          details: { model: modelName, provider: providerName, reason: finalReason, message: llmMessage },
        });
        const errorEntry: LogEntry = {
          level: "error",
          domain: "llm",
          message: llmMessage ?? "LLM stream error",
          code: "LLM_STREAM_ERROR",
          details: { model: modelName, provider: providerName, reason: finalReason },
        };
        s.onError?.(errorEntry);
      }
    }

    lastStreamReason = finalReason;
    if (finalReason === "error" || finalReason === "aborted") {
      lastLlmErrorMessage =
        extractLlmErrorMessage(finalMessage) ?? lastLlmErrorMessage;
    }

    if (interrupted) break;

    if (finalMessage) {
      const assistantTokens = estimateAssistantMessageTokens(finalMessage);
      if (assistantTokens > 0) {
        turnHistoryTokens += assistantTokens;
        s.onContextHistoryDelta?.({
          tokensAdded: assistantTokens,
          source: "assistant",
        });
      }
      history.push(finalMessage);
    }

    if (!pendingToolCalls.length || finalReason !== "toolUse") {
      break;
    }

    // Check if we've reached the step limit
    if (step === maxSteps - 1) {
      // We're on the last step and the model wants more tools — warn the user
      const limitBanner = `Reached per-turn tool step limit (${maxSteps}/${maxSteps}). Send another message to continue, or raise turn.max_steps in praana.config.toml.`;
      s.onSystemLines?.([limitBanner]);
    }

    const toolResults: Array<{ toolCallId?: string; toolName: string; result: unknown }> = [];
    const recalledEntryIdsThisTurn = new Set<string>();


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
        payload: { toolCallId: tc.toolCallId, tool: tc.toolName, args: tc.args },
      });

      // Always notify the UI about the incoming tool call (show pending row in TUI,
      // print compact line in terminal mode). Then start the spinner while it executes.
      s.onToolCall?.(tc.toolCallId, tc.toolName, tc.args);
      s.onSpinnerStart?.(tc.toolName);
      if (tc.toolName !== "load_skill") hadNonLoadSkillTool = true;

      const toolDef = (tools as Record<string, any>)[tc.toolName];
      let result: unknown;
      let isError = false;

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

      s.onSpinnerStop?.();

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

      toolResults.push({ toolCallId: tc.toolCallId, toolName: tc.toolName, result });

      let promptResultText = toolResultRawText(result);
      let artifactId: string | undefined;
      const skippedDisk =
        result &&
        typeof result === "object" &&
        (result as { skipped_disk?: unknown }).skipped_disk === true;
      const resultArtifactId =
        result &&
        typeof result === "object" &&
        typeof (result as { artifact_id?: unknown }).artifact_id === "string"
          ? ((result as { artifact_id: string }).artifact_id)
          : undefined;

      if (session.contextEngine && skippedDisk && resultArtifactId) {
        artifactId = resultArtifactId;
        promptResultText =
          typeof (result as { content?: unknown }).content === "string"
            ? (result as { content: string }).content
            : promptResultText;
        const toolTokens = estimateDisplayTokens(promptResultText);
        turnHistoryTokens += toolTokens;
        s.onContextHistoryDelta?.({
          tokensAdded: toolTokens,
          source: "tool",
        });
      } else if (session.contextEngine) {
        const command = resolveToolCommand(
          tc.toolName,
          tc.args as Record<string, unknown>,
          session.cwd,
        );
        const ingested = session.contextEngine.ingestToolResult({
          sourceTool: tc.toolName,
          command,
          rawText: promptResultText,
          createdTurn: session.getTurnCount(),
        });
        promptResultText = ingested.promptText;
        artifactId = ingested.artifactId;
        const toolTokens = estimateDisplayTokens(promptResultText);
        const savings = computeDistillerSavings(
          toolResultRawText(result),
          promptResultText,
          ingested.inlined,
        );
        turnHistoryTokens += toolTokens;
        turnDistillerSavings += savings;
        s.onContextHistoryDelta?.({
          tokensAdded: toolTokens,
          source: "tool",
          distillerSavings: savings > 0 ? savings : undefined,
        });
      } else {
        const toolTokens = estimateDisplayTokens(promptResultText);
        turnHistoryTokens += toolTokens;
        s.onContextHistoryDelta?.({
          tokensAdded: toolTokens,
          source: "tool",
        });
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
        payload: { toolCallId: tc.toolCallId, tool: tc.toolName, result },
      });

      // Notify UI sink of tool result for distinct rendering (e.g. TUI).
      // Shell uses raw result so TUI shows stdout/stderr even when context engine artifacts.
      const uiResultText =
        tc.toolName === "shell" ? toolResultRawText(result) : promptResultText;
      s.onToolResult?.(tc.toolCallId, tc.toolName, uiResultText, isError);

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

  // Mark resident skills as used if any non-load_skill tool call executed this turn.
  // "loaded a skill and did nothing else" is the idle case the usefulness loop penalizes.
  if (session.skillRuntime && hadNonLoadSkillTool) {
    session.skillRuntime.markResidentSkillsUsed();
  }

  if (interrupted) {
    commitTurnContextDisplay(session, s, {
      contextWindowTokens,
      engineMode: useEngineCompiler,
      historyTokens: turnHistoryTokens,
      distillerSavingsTurn: turnDistillerSavings,
    });
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
      providerUsage,
      recordedProviderUsage,
    );
  }

  if (fullResponse && !fullResponse.endsWith("\n")) {
    s.onNewline?.();
    fullResponse += "\n";
  }

  if (!fullResponse.trim()) {
    const code =
      lastStreamReason === "error"
        ? "LLM_STREAM_ERROR"
        : lastStreamReason === "aborted"
          ? "LLM_ABORTED"
          : "LLM_EMPTY_RESPONSE";
    if (lastStreamReason !== "error" && lastStreamReason !== "aborted") {
      llmLogger.warn("LLM returned no text content", {
        code: "LLM_EMPTY_RESPONSE",
        details: { model: modelName, provider: providerName, reason: lastStreamReason },
      });
    }
    const fallback = formatUserFacingLlmError({
      reason: lastStreamReason,
      llmMessage: lastLlmErrorMessage,
      model: modelName,
      provider: providerName,
    });
    const errorEntry: LogEntry = {
      level: lastStreamReason === "error" ? "error" : "warn",
      domain: "llm",
      message: lastLlmErrorMessage ?? "No text content in LLM response",
      code,
      details: { model: modelName, provider: providerName, reason: lastStreamReason },
    };
    s.onError?.(errorEntry);
    s.onFallback?.(fallback);
    // For errors, append a graceful message to the transcript instead of the raw error.
    // The fallback (with raw error details) is still shown to the user via onFallback.
    if (lastStreamReason === "error") {
      fullResponse = "I encountered an error while processing your request. Please try again.";
    } else {
      fullResponse = fallback;
    }
  }

  // 6. Append agent_message
  session.eventLog.append({
    kind: "agent_message",
    actor: "agent",
    payload: { text: fullResponse },
  });

  const turnInputTokens = providerUsage?.input ?? promptMetrics.totalTokens;
  const turnOutputTokens = providerUsage?.output ?? estimateTokens(fullResponse);
  if (!recordedProviderUsage) {
    session.recordInputTokens(turnInputTokens);
    session.recordOutputTokens(turnOutputTokens);
  }

  // 6b. Backfill deferred distillations and persist ledger + turn digest
  if (session.contextEngine && stateBeforeTurn) {
    await session.contextEngine.flushDeferredDistillation();
    const turnRecord = turnRecorder.toRecord(
      fullResponse,
      session.getTurnCount(),
      turnInputTokens + turnOutputTokens,
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
  session.scorecard.inc("totalTurns");
  session.scorecard.persistProgress();
  if (!classicMode) {
    applyTierManagement(session);
    session.skillRuntime?.cleanupStaleSkills(session.getTurnCount());
    flushSkillTelemetry(session);
  }
  session.persistStateGraphCheckpoint();

  // 8. Memory banner — count recall calls & hits from this turn's events
  commitTurnContextDisplay(session, s, {
    contextWindowTokens,
    engineMode: useEngineCompiler,
    historyTokens: turnHistoryTokens,
    distillerSavingsTurn: turnDistillerSavings,
  });
  const stats = computeMemoryStats(session, autoHydrated.length, turnInputTokens, turnOutputTokens);
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
  sink?: TurnUiSink,
  providerUsage: ProviderUsage | null = null,
  recordedProviderUsage = false,
): never {
  const trimmed = partialResponse.trim();
  const messageText = trimmed
    ? `${trimmed}\n\n[interrupted]`
    : "[interrupted]";
  const turnInputTokens = providerUsage?.input ?? promptTokens;
  const turnOutputTokens = providerUsage?.output ?? estimateTokens(trimmed);

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

  if (!recordedProviderUsage) {
    session.recordInputTokens(turnInputTokens);
    session.recordOutputTokens(turnOutputTokens);
  }

  if (session.contextEngine && stateBeforeTurn) {
    void session.contextEngine.flushDeferredDistillation();
    const turnRecord = turnRecorder.toRecord(
      messageText,
      session.getTurnCount(),
      turnInputTokens + turnOutputTokens,
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
  session.scorecard.inc("totalTurns");
  session.scorecard.persistProgress();
  if (!classicMode) {
    applyTierManagement(session);
    session.skillRuntime?.cleanupStaleSkills(session.getTurnCount());
    flushSkillTelemetry(session);
  }
  session.persistStateGraphCheckpoint();

  const stats = computeMemoryStats(session, autoHydrated, turnInputTokens, turnOutputTokens);
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

export interface MemoryBannerStats {
  activeState: number;
  totalState: number;
  digestLen: number;
  recallCalls: number;
  recallHits: number;
  autoHydrated: number;
  promptTokens: number;
  outputTokens: number;
  /** Session-scoped scorecard repeat_file_reads (for footer nudge). */
  repeatFileReads?: number;
}

function commitTurnContextDisplay(
  session: Session,
  sink: TurnUiSink,
  input: {
    contextWindowTokens: number;
    engineMode: boolean;
    historyTokens: number;
    distillerSavingsTurn: number;
  },
): void {
  const built = buildContextDisplaySnapshot({
    session,
    contextWindowTokens: input.contextWindowTokens,
    engineMode: input.engineMode,
    historyTokens: input.historyTokens,
    distillerSavingsTurn: input.distillerSavingsTurn,
  });
  const snapshot = maxContextSnapshot(built, sink.getContextPreview?.());
  session.setDisplayContextSnapshot(snapshot);
  sink.onTurnContextCommit?.(snapshot);
}

export function computeMemoryStats(
  session: Session,
  autoHydrated: number,
  promptTokens?: number,
  outputTokens?: number,
): MemoryBannerStats {
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
    repeatFileReads: session.scorecard?.getCounters?.().repeatFileReads ?? 0,
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

/** Prefer absolute paths for read_file so artifact file-read index matches interceptor. */
function resolveToolCommand(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): string | undefined {
  const raw = toolCommandFromArgs(toolName, args);
  if (!raw) return undefined;
  if (toolName === "read_file") {
    return isAbsolute(raw) ? raw : resolve(cwd, raw);
  }
  return raw;
}
