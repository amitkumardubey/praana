import { stream as piStream, type Message } from "@earendil-works/pi-ai";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import type { Session } from "./session.js";
import { compileWithMetrics } from "./compiler.js";
import { createAllTools, describeTools } from "./tools/index.js";
import { createProvider, resolveModel } from "./llm.js";
import {
  printDebug,
  printDebugBlock,
  printMemoryBanner,
  printToolCall,
  startSpinner,
  stopSpinner,
} from "./ui.js";
import { TurnAbortedError } from "./turn-control.js";

export async function runTurn(
  session: Session,
  userInput: string,
  modelOverride?: string,
  options?: {
    onTextDelta?: (delta: string) => void;
    onThinkingDelta?: (delta: string) => void;
    signal?: AbortSignal;
  }
): Promise<string> {
  // 1. Append user_message
  session.eventLog.append({
    kind: "user_message",
    actor: "user",
    payload: { text: userInput },
  });

  // 1b. Auto-hydrate peripheral objects matching user query keywords
  const autoHydrated = session.stateGraph.autoHydrate(userInput);
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
      printDebug(`auto-hydrated ${autoHydrated.length} object(s): ${autoHydrated.join(", ")}`);
    }
  }

  // 2. Build tools
  const tools = createAllTools({
    eventLog: session.eventLog,
    stateGraph: session.stateGraph,
    memoryStore: session.memoryStore,
    memoryEnabled: session.memoryEnabled,
    cwd: session.cwd,
    getAbortSignal: () => options?.signal,
  });

  // 3. Compile prompt (system only, user input passed as message)
  const recentEvents = session.eventLog.readLast(
    session.config.compiler.recent_turns
  );
  const toolDescs = describeTools();

  const { prompt: compiledPrompt, metrics: promptMetrics } = compileWithMetrics({
    stateGraph: session.stateGraph,
    memoryDigest: session.digest,
    recentEvents,
    toolSchemas: toolDescs,
    cwd: session.cwd,
    sessionId: session.id,
    tokenBudget: session.config.compiler.token_budget,
    recentTurnsTokenBudget: session.config.compiler.recent_turns_token_budget,
    agentsContext: session.agentsContext,
  });
  session.setLastCompileMetrics(promptMetrics);

  if (session.debug) {
    const turnNum = session.getTurnCount() + 1;
    const promptDir = session.promptDir;
    if (!existsSync(promptDir)) mkdirSync(promptDir, { recursive: true });
    const promptFile = join(promptDir, `turn-${String(turnNum).padStart(3, "0")}.md`);
    writeFileSync(promptFile, compiledPrompt, "utf-8");
    printDebug(`prompt saved → ${promptFile}`);
  }

  // 4. Create LLM provider and model
  const provider = createProvider(session.config.llm);
  const modelName = modelOverride ?? session.config.llm.model;
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
        if (options?.onTextDelta) options.onTextDelta(event.delta);
        else process.stdout.write(event.delta);
        fullResponse += event.delta;
      }
      if (event.type === "thinking_delta" && typeof event.delta === "string") {
        if (options?.onThinkingDelta) options.onThinkingDelta(event.delta);
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

      if (!session.debug) startSpinner(tc.toolName);

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

      if (!session.debug) {
        stopSpinner();
        printToolCall(tc.toolName, tc.args);
      }

      toolResults.push({ toolName: tc.toolName, result });

      history.push({
        role: "toolResult",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError,
        timestamp: Date.now(),
      });

      session.eventLog.append({
        kind: "tool_result",
        actor: "tool",
        payload: { tool: tc.toolName, result },
      });

      if (options?.signal?.aborted) {
        interrupted = true;
        break;
      }
    }

    if (interrupted) break;

    stepIndex++;
    if (session.debug) {
      printDebugBlock(stepIndex, pendingToolCalls, toolResults);
    }
  }

  if (interrupted) {
    return finalizeInterruptedTurn(session, fullResponse, autoHydrated.length, promptMetrics.totalTokens);
  }

  if (fullResponse && !fullResponse.endsWith("\n")) {
    process.stdout.write("\n");
    fullResponse += "\n";
  }

  if (!fullResponse.trim()) {
    const fallback =
      "[no response from model — try again or switch models with /model]";
    process.stdout.write(fallback + "\n");
    fullResponse = fallback;
  }

  // 6. Append agent_message
  session.eventLog.append({
    kind: "agent_message",
    actor: "agent",
    payload: { text: fullResponse },
  });

  // 7. Increment turn and run tier management
  session.incrementTurn();
  applyTierManagement(session);

  // 8. Memory banner — count recall calls & hits from this turn's events
  const stats = computeMemoryStats(session, autoHydrated.length);
  stats.promptTokens = promptMetrics.totalTokens;
  printMemoryBanner(stats);

  return fullResponse;
}

function finalizeInterruptedTurn(
  session: Session,
  partialResponse: string,
  autoHydrated: number,
  promptTokens: number
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

  session.incrementTurn();
  applyTierManagement(session);

  const stats = computeMemoryStats(session, autoHydrated);
  stats.promptTokens = promptTokens;
  printMemoryBanner(stats);

  throw new TurnAbortedError(trimmed);
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
  autoHydrated: number
): {
  activeState: number;
  totalState: number;
  digestLen: number;
  recallCalls: number;
  recallHits: number;
  autoHydrated: number;
  promptTokens?: number;
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
  };
}
