import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EVENT_LOG_FILENAME, migrateLegacyEventLog } from "./event-log.js";
import type { Session } from "./session.js";
import { getHelpLines as bannerHelpLines } from "./app-banner.js";
import { explainUnitScore } from "./context-engine/engine-compiler.js";
import { resolveContextEngineConfig } from "./context-engine/index.js";

export type SlashCommandAction = "none" | "exit" | "refresh_status";

export interface SlashCommandResult {
  action: SlashCommandAction;
  lines: string[];
}

export async function executeSlashCommand(
  input: string,
  session: Session,
  handlers: {
    setModel: (m?: string) => void;
    setThinking: (v: boolean) => void;
    getThinking: () => boolean;
  }
): Promise<SlashCommandResult> {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const lines: string[] = [];

  const result = (action: SlashCommandAction = "none"): SlashCommandResult => ({
    action,
    lines,
  });

  switch (cmd) {
    case "/exit":
    case "/quit": {
      lines.push("Ending session...");
      return result("exit");
    }

    case "/state": {
      const objects = session.stateGraph.list();
      if (objects.length === 0) {
        lines.push(
          "No state objects yet this session. Use remember() or create_task() to start tracking."
        );
      } else {
        lines.push(`State objects (${objects.length}):`);
        for (const o of objects) {
          const tierIcon =
            o.tier === "active" ? "●" : o.tier === "soft" ? "○" : "·";
          lines.push(`  ${tierIcon} ${o.id} [${o.kind}] ${o.tier}: ${o.summary}`);
        }
      }
      break;
    }

    case "/stats": {
      const stats = session.getMemoryStats();
      const startedAt = new Date(session.getStartedAt()).toISOString();
      const uptimeSec = Math.floor(session.getUptimeMs() / 1000);
      const persistentCount = session.getPersistentMemoryEntryCount();
      lines.push("", "Session:");
      lines.push(`  Session ID: ${session.id}`);
      lines.push(`  Turns: ${session.getTurnCount()}`);
      lines.push(`  Started at: ${startedAt}`);
      lines.push(`  Uptime: ${uptimeSec}s`);

      const inTokens = session.getInputTokens();
      const outTokens = session.getOutputTokens();
      if (inTokens > 0 || outTokens > 0) {
        lines.push(
          `  Tokens (this boot): ${inTokens.toLocaleString()} in / ${outTokens.toLocaleString()} out`
        );
      }

      lines.push("", "Working memory (this session):");
      lines.push(`  Total: ${stats.total}`);
      lines.push(`  Active: ${stats.active}`);
      lines.push(`  Soft: ${stats.soft}`);
      lines.push(`  Hard: ${stats.hard}`);
      const kindParts = Object.entries(stats.byKind)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, count]) => `${kind}:${count}`);
      lines.push(`  By kind: ${kindParts.length ? kindParts.join(", ") : "(none)"}`);

      if (session.memoryEnabled) {
        lines.push("", "Persistent memory (SQLite):");
        lines.push(`  Total memories: ${persistentCount ?? "(unavailable)"}`);
        lines.push(`  Memory DB: ${session.getMemoryDbPath() ?? "(unknown)"}`);
      }

      if (session.isContextEngineEnabled() && session.contextEngine) {
        const telemetry = session.contextEngine.finalizeTelemetry(session.getTurnCount());
        lines.push("", "Context engine telemetry:");
        lines.push(`  Artifacts: ${telemetry.artifactsProduced}`);
        lines.push(
          `  Retrievals: ${telemetry.stats.artifactRetrievals} (${(telemetry.retrievalRate * 100).toFixed(1)}%)`,
        );
        lines.push(`  Distiller savings: ${Math.round(telemetry.stats.totalDistillerSavings)} tokens`);
        lines.push(`  Pressure events: ${telemetry.stats.pressureEvents}`);
        lines.push(`  Compaction triggers: ${telemetry.stats.compactionTriggers}`);
      }
      break;
    }

    case "/digest": {
      if (session.digest) {
        lines.push("", session.digest);
      } else {
        lines.push("No digest available.");
      }
      break;
    }

    case "/events": {
      const events = session.eventLog.readLast(20);
      if (events.length === 0) {
        lines.push("No events yet.");
      } else {
        lines.push(``, `Last ${events.length} events:`);
        for (const ev of events) {
          const time = new Date(ev.timestamp).toISOString().slice(11, 19);
          const summary =
            ev.kind === "user_message"
              ? `User: ${(ev.payload.text as string)?.slice(0, 60)}`
              : ev.kind === "agent_message"
                ? `Agent: ${(ev.payload.text as string)?.slice(0, 60)}`
                : ev.kind === "tool_call"
                  ? `Tool: ${ev.payload.tool ?? "?"}`
                  : ev.kind === "tool_result"
                    ? `Result: ${JSON.stringify(ev.payload.result)?.slice(0, 60)}`
                    : ev.kind === "context_action"
                      ? `Context: ${ev.payload.action}`
                      : ev.kind;
          lines.push(`  ${time} ${ev.kind.padEnd(16)} ${summary}`);
        }
      }
      break;
    }

    case "/recall": {
      const query = parts.slice(1).join(" ");
      if (!query || !session.memoryEnabled || !session.memoryStore) {
        lines.push("Usage: /recall <query> (requires memory enabled)");
        break;
      }
      try {
        const recallResult = await session.memoryStore.recall(query, { limit: 20 });
        if (recallResult.entries.length === 0) {
          lines.push("No results found.");
        } else {
          lines.push(``, `Recall results for "${query}":`);
          for (const e of recallResult.entries) {
            lines.push(
              `  - [${e.kind}] ${e.content.slice(0, 100)} (match: ${e.match.toFixed(2)} | conf: ${e.confidence.toFixed(2)})`
            );
          }
        }
      } catch (err) {
        lines.push(`Recall error: ${(err as Error).message}`);
      }
      break;
    }

    case "/sessions": {
      const logDir = session.config.session.log_dir;
      if (!existsSync(logDir)) {
        lines.push("No sessions directory found.");
        break;
      }
      const dirs = readdirSync(logDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .sort((a, b) => b.name.localeCompare(a.name))
        .slice(0, 15);
      if (dirs.length === 0) {
        lines.push("No sessions found.");
        break;
      }
      lines.push("", "Recent sessions:");
      for (const d of dirs) {
        const sessionDir = join(logDir, d.name);
        migrateLegacyEventLog(sessionDir);
        const eventsPath = join(sessionDir, EVENT_LOG_FILENAME);
        const metaPath = join(logDir, d.name, "meta.json");
        let events = 0;
        let cwdLabel = "?";
        let time = "?";
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          cwdLabel = meta.cwd?.split("/").pop() ?? meta.cwd ?? "?";
          time = new Date(meta.started_at).toISOString().slice(0, 16).replace("T", " ");
        } catch {
          /* ignore */
        }
        try {
          const content = readFileSync(eventsPath, "utf-8");
          events = content.split("\n").filter(Boolean).length;
        } catch {
          /* ignore */
        }
        const marker = d.name === session.id ? " ← current" : "";
        lines.push(
          `  ${time}  ${d.name.slice(0, 12)}...  ${String(events).padStart(4)} events  ${cwdLabel}${marker}`
        );
      }
      lines.push("", "Resume with: aria resume <session-id>");
      break;
    }

    case "/model": {
      const model = parts[1];
      if (!model) {
        lines.push(`Current model: ${session.getModelOverride() ?? session.config.llm.model}`);
        lines.push("Usage: /model <provider/model> (e.g., /model openai/gpt-4o)");
        break;
      }
      const trimmed = model.trim();
      handlers.setModel(trimmed);
      session.setModelOverride(trimmed);
      const contextWindow = await session.refreshModelContextWindow(trimmed);
      session.eventLog.append({
        kind: "system_note",
        actor: "kernel",
        payload: {
          type: "model_override",
          model: trimmed,
        },
      });
      lines.push(`Model switched to: ${model} (${contextWindow.toLocaleString()} ctx)`);
      return result("refresh_status");
    }

    case "/debug": {
      session.debug = !session.debug;
      lines.push(
        `Debug mode: ${session.debug ? "ON" : "OFF"}` +
          ` (prompts saved to ${session.promptDir}` +
          `${session.isContextEngineEnabled() ? ", scores to scores.jsonl" : ""})`
      );
      return result("refresh_status");
    }

    case "/thinking": {
      const arg = (parts[1] ?? "").toLowerCase();
      if (!arg) {
        lines.push(`Thinking: ${handlers.getThinking() ? "ON" : "OFF"}`);
        lines.push("Usage: /thinking <on|off>");
        break;
      }
      if (arg === "on") {
        handlers.setThinking(true);
        lines.push("Thinking enabled.");
      } else if (arg === "off") {
        handlers.setThinking(false);
        lines.push("Thinking disabled.");
      } else {
        lines.push("Usage: /thinking <on|off>");
      }
      return result("refresh_status");
    }

    case "/incognito": {
      const arg = (parts[1] ?? "").toLowerCase();
      if (!arg) {
        lines.push(`Incognito: ${session.isIncognito() ? "ON" : "OFF"}`);
        lines.push("Usage: /incognito <on|off>");
        break;
      }
      if (arg === "on") {
        await session.setIncognito(true);
        lines.push("Incognito enabled — cross-session memory disabled.");
      } else if (arg === "off") {
        await session.setIncognito(false);
        lines.push(
          session.memoryEnabled
            ? "Incognito disabled — cross-session memory enabled."
            : "Incognito disabled — memory remains unavailable (check config.memory.enabled)."
        );
      } else {
        lines.push("Usage: /incognito <on|off>");
      }
      break;
    }

    case "/clear":
    case "/new": {
      session.clearState();
      session.eventLog.append({
        kind: "system_note",
        actor: "kernel",
        payload: {
          type: "state_reset",
          cleared: "all",
          command: cmd,
        },
      });
      lines.push("State cleared. Starting fresh.");
      break;
    }

    case "/why": {
      const unitId = parts.slice(1).join(" ").trim();
      if (!unitId) {
        lines.push("Usage: /why <unit-id> (e.g. /why art_abc123 or /why turn_3)");
        break;
      }
      if (!session.isContextEngineEnabled()) {
        lines.push("Context engine is disabled. Enable it to use /why.");
        break;
      }
      const record = session.getCompileScoreRecord(unitId);
      if (!record) {
        lines.push(`No score record for "${unitId}" on the last compile.`);
        lines.push("Run a turn with context_engine.enabled=true and debug mode for scores.jsonl.");
        break;
      }
      const engineConfig = resolveContextEngineConfig(session.config);
      const bandBudget = record.band <= 4 ? 3000 : 2000;
      const bandUsed = session
        .getLastCompileScoreRecords()
        .filter((r) => r.band === record.band && r.included)
        .reduce((sum, r) => sum + r.tokens, 0);
      lines.push(
        ...explainUnitScore(
          unitId,
          session.getLastCompileScoreRecords(),
          session.getTurnCount(),
          session.getLastUserInput(),
          engineConfig.scoring,
          bandBudget,
          bandUsed,
        ),
      );
      lines.push(
        `Pressure: ${(session.getLastPressureRatio() * 100).toFixed(1)}% (${session.getLastPressureMode()})`,
      );
      break;
    }

    case "/help": {
      return { action: "none", lines: bannerHelpLines() };
    }

    default:
      lines.push(`Unknown command: ${cmd}. Type /help for available commands.`);
  }

  return result();
}
