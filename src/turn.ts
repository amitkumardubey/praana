import { streamText } from "ai";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "./session.js";
import { compileWithMetrics } from "./compiler.js";
import { createAllTools, describeTools } from "./tools/index.js";
import { createProvider, resolveModel } from "./llm.js";
import {
  printDebug,
  printMemoryBanner,
  printToolBlockEnd,
  printToolBlockStart,
  printToolCall,
  printToolCallDebug,
  printToolResultDebug,
} from "./ui.js";

export async function runTurn(
  session: Session,
  userInput: string,
  modelOverride?: string
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
  });

  // 3. Compile prompt (system only, user input passed as message)
  const recentEvents = session.eventLog.readLast(
    session.config.compiler.recent_turns
  );
  const toolDescs = describeTools();

  const { prompt: compiledPrompt, metrics: promptMetrics } = compileWithMetrics({
    stateGraph: session.stateGraph,
    bodhaDigest: session.digest,
    recentEvents,
    toolSchemas: toolDescs,
    cwd: session.cwd,
    sessionId: session.id,
    tokenBudget: session.config.compiler.token_budget,
    recentTurnsTokenBudget: session.config.compiler.recent_turns_token_budget,
  });

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

  const result = streamText({
    model,
    system: compiledPrompt,
    messages: [{ role: "user", content: userInput }],
    tools,
    maxSteps: 25,
    onStepFinish: ({ toolCalls, toolResults }) => {
      if (toolCalls) {
        for (const tc of toolCalls) {
          session.eventLog.append({
            kind: "tool_call",
            actor: "tool",
            payload: { tool: tc.toolName, args: tc.args },
          });
        }
      }
      if (toolResults) {
        for (const tr of toolResults) {
          session.eventLog.append({
            kind: "tool_result",
            actor: "tool",
            payload: { tool: tr.toolName, result: tr.result },
          });
        }
      }

      if (!toolCalls?.length) return;

      stepIndex++;

      if (session.debug) {
        printToolBlockStart(stepIndex);
        for (const tc of toolCalls) {
          printToolCallDebug(tc.toolName, tc.args as Record<string, unknown>);
        }
        if (toolResults) {
          for (const tr of toolResults) {
            printToolResultDebug(tr.toolName, tr.result);
          }
        }
        printToolBlockEnd();
      } else {
        for (const tc of toolCalls) {
          printToolCall(tc.toolName, tc.args as Record<string, unknown>);
        }
      }
    },
  });

  // Stream agent text to stdout only
  for await (const delta of result.textStream) {
    process.stdout.write(delta);
    fullResponse += delta;
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

function applyTierManagement(session: Session): void {
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

function computeMemoryStats(
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
