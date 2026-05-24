import { streamText } from "ai";
import type { Session } from "./session.js";
import { compile } from "./compiler.js";
import { createAllTools, describeTools } from "./tools/index.js";
import { createProvider, resolveModel } from "./llm.js";

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

  // 2. Build tools
  const tools = createAllTools({
    eventLog: session.eventLog,
    stateGraph: session.stateGraph,
    bodhaClient: session.bodhaClient,
    bodhaEnabled: session.bodhaEnabled,
    cwd: session.cwd,
  });

  // 3. Compile prompt (system only, user input passed as message)
  const recentEvents = session.eventLog.readLast(
    session.config.compiler.recent_turns
  );
  const toolDescs = describeTools();

  const compiledPrompt = compile({
    stateGraph: session.stateGraph,
    bodhaDigest: session.digest,
    recentEvents,
    // userInput passed as a separate message below, not in system prompt
    toolSchemas: toolDescs,
    cwd: session.cwd,
    sessionId: session.id,
    tokenBudget: session.config.compiler.token_budget,
  });

  // 4. Create LLM provider and model
  const provider = createProvider(session.config.llm);
  const modelName = modelOverride ?? session.config.llm.model;
  const model = provider(resolveModel(modelName));

  // 5. Stream response
  let fullResponse = "";

  // Collect conversation history from recent events
  // For MVP: we use the compiled prompt as system, and empty messages (the SDK needs at least one)
  // The new ai v4 SDK uses system + messages approach

  const result = streamText({
    model,
    system: compiledPrompt,
    messages: [
      { role: "user", content: userInput },
    ],
    tools,
    maxSteps: 25,
    onStepFinish: ({ toolCalls, toolResults }) => {
      // Log all tool calls and results automatically
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
    },
  });

  // Stream text to stdout
  for await (const delta of result.textStream) {
    process.stdout.write(delta);
    fullResponse += delta;
  }

  // Ensure final newline
  if (fullResponse && !fullResponse.endsWith("\n")) {
    process.stdout.write("\n");
    fullResponse += "\n";
  }

  // 6. Append agent_message
  session.eventLog.append({
    kind: "agent_message",
    actor: "agent",
    payload: { text: fullResponse },
  });

  // 7. Increment turn and run tier management
  session.incrementTurn();

  // Apply idle-based tier management (check every turn)
  // This is a simplified rule-based approach per AGENTS.md
  applyTierManagement(session);

  return fullResponse;
}

function applyTierManagement(session: Session): void {
  const { idle_soft_after_turns, idle_hard_after_turns } =
    session.config.tiers;
  const sg = session.stateGraph;
  const currentTurn = sg.getTurnCount();

  // Rule 1: Active → Soft if idle for N+ turns
  for (const obj of sg.getActive()) {
    const touchedTurn = sg.getTouchedTurn(obj.id);
    const idleTurns = currentTurn - touchedTurn;
    if (idleTurns >= idle_hard_after_turns) {
      sg.setTier(obj.id, "hard");
    } else if (idleTurns >= idle_soft_after_turns) {
      sg.setTier(obj.id, "soft");
    }
  }

  // Rule 2: Soft → Hard if idle for hard threshold+
  for (const obj of sg.getPeripheral()) {
    if (obj.tier !== "soft") continue;
    const touchedTurn = sg.getTouchedTurn(obj.id);
    const idleTurns = currentTurn - touchedTurn;
    if (idleTurns >= idle_hard_after_turns) {
      sg.setTier(obj.id, "hard");
    }
  }

  // Rule 3: Token budget overflow (run after each turn if needed)
  // Token budget is checked during compilation; here we defer to the compiler's warning.
}
