import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  EVENT_LOG_FILENAME,
  migrateLegacyEventLog,
  sessionActivityAt,
} from "./event-log.js";
import type { Session } from "./session.js";
import { nativeStatusToString } from "./native/index.js";
import { getHelpLines as bannerHelpLines } from "./app-banner.js";
import { explainUnitScore } from "./context-engine/engine-compiler.js";
import { resolveContextEngineConfig, resolveContextDbPath } from "./context-engine/index.js";
import {
  formatScorecardLines,
  scorecardHasData,
} from "./context-engine/telemetry.js";
import {
  formatContextPressureStats,
  resolveEnginePressureMode,
} from "./context-pressure.js";
import {
  resolveModelSpecifier,
  getProviderConfigurationError,
  resolvedTargetLabel,
  parseModelCommandArgs,
} from "./model-resolver.js";
import { getProviderEnvKey, parseReasoningEffort, REASONING_EFFORT_LEVELS } from "./llm.js";
import { listStoredProviders } from "./credentials.js";
import { isUserDeclaredProvider } from "./provider-registry.js";
import { logoutProvider } from "./setup/logout.js";
import { executeShellCommand } from "./tools/system.js";
import {
  USER_SETTINGS_KEYS,
  getUserSettingsPath,
  isUserSettingsKey,
  loadUserSettings,
  parseSettingsSetValue,
  resetUserSettings,
  updateUserSettings,
  type UserSettings,
  type UserSettingsKey,
} from "./user-settings.js";

export type SlashCommandAction =
  | "none"
  | "exit"
  | "refresh_status"
  | "clear_transcript"
  | "new_session"
  | "open_model_selector"
  | "open_login_wizard"
  | "open_logout_wizard"
  | "open_setup_wizard";

/** toast = ephemeral feedback below input; transcript = scrollback (default). */
export type SlashCommandDisplay = "transcript" | "toast" | "inline_transcript";

export type SlashCommandToastTone = "info" | "success" | "error";

/**
 * Single source of truth for slash-command metadata surfaced in the TUI
 * autocomplete dropdown (see src/ui/tui/run.ts). The `switch (cmd)` dispatch
 * below remains the behavioral authority, but every dispatchable command MUST
 * also appear here so the dropdown never drifts from the real command set.
 * Keep the two in sync — tests/slash-commands.test.ts guards against drift.
 */
export type SlashCommandCategory =
  | "Session"
  | "Memory"
  | "Model & Config"
  | "Tools"
  | "Insight";

export interface SlashCommandMeta {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  category: SlashCommandCategory;
}

export const SLASH_COMMAND_METADATA: SlashCommandMeta[] = [
  { name: "/exit", description: "End session", aliases: ["/quit"], category: "Session" },
  { name: "/state", description: "List working-memory state objects", category: "Insight" },
  { name: "/stats", description: "Session metadata + memory stats", category: "Insight" },
  { name: "/scorecard", description: "Per-session telemetry scorecard", category: "Insight" },
  { name: "/digest", description: "Show Cognitive Memory digest", category: "Memory" },
  { name: "/events", description: "Show recent event-log entries", category: "Insight" },
  { name: "/recall", description: "Search Cognitive Memory", argumentHint: "<query>", category: "Memory" },
  { name: "/model", description: "Switch model mid-session", argumentHint: "[provider] <id>", category: "Model & Config" },
  { name: "/sessions", description: "List past sessions", category: "Session" },
  { name: "/shell", description: "Run a shell command directly", argumentHint: "<command>", category: "Tools" },
  { name: "/debug", description: "Toggle debug mode", category: "Tools" },
  { name: "/thinking", description: "Toggle reasoning stream visibility", argumentHint: "on|off", category: "Model & Config" },
  { name: "/reasoning", description: "Set reasoning effort level", argumentHint: "off|minimal|low|medium|high|xhigh", category: "Model & Config" },
  { name: "/incognito", description: "Toggle memory persistence", argumentHint: "on|off", category: "Memory" },
  { name: "/settings", description: "View or update persistent settings", argumentHint: "[set <key> <value>|reset]", category: "Model & Config" },
  { name: "/plan", description: "Toggle plan mode", argumentHint: "on|off|execute|go", category: "Tools" },
  { name: "/why", description: "Explain context-unit scoring", argumentHint: "<unit-id>", category: "Insight" },
  { name: "/memory", description: "Manage Cognitive Memory", argumentHint: "dedupe", category: "Memory" },
  { name: "/login", description: "Add or update a provider", argumentHint: "[provider]", category: "Model & Config" },
  { name: "/logout", description: "Remove a provider's credentials", argumentHint: "[provider]", category: "Model & Config" },
  { name: "/setup", description: "Run provider/config setup wizard", category: "Model & Config" },
  { name: "/clear", description: "Reset in-session context", category: "Session" },
  { name: "/new", description: "Start a new session", category: "Session" },
  { name: "/help", description: "Show all commands", category: "Insight" },
];

export interface SlashCommandResult {
  action: SlashCommandAction;
  lines: string[];
  display?: SlashCommandDisplay;
  toastTone?: SlashCommandToastTone;
  /** Structured shell-run output for TUI tool-row rendering. */
  shellRun?: {
    command: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    ok: boolean;
  };
  /** Provider hint passed to the login wizard overlay (from /login <provider>). */
  loginProviderHint?: string;
}

type ModelSwitchOutcome = "success" | "failed" | "already_on";

type SlashHandlers = {
  setModel: (m?: string) => void;
  setThinking: (v: boolean) => void;
  getThinking: () => boolean;
  isTurnActive?: () => boolean;
};

function formatSettingValue(value: string | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return value === "" ? '(empty)' : value;
}

function sessionEffectiveSettings(
  session: Session,
  handlers: SlashHandlers,
): Record<UserSettingsKey, string> {
  return {
    model: session.getModelOverride() ?? session.config.llm.model ?? "",
    provider: session.getProviderOverride() ?? session.config.llm.provider ?? "",
    thinking: handlers.getThinking() ? "true" : "false",
    incognito: session.isIncognito() ? "true" : "false",
    debug: session.debug ? "true" : "false",
    theme: loadUserSettings().settings.theme,
  };
}

async function applySettingToSession(
  session: Session,
  handlers: SlashHandlers,
  key: UserSettingsKey,
  value: string | boolean,
): Promise<void> {
  switch (key) {
    case "model":
      session.setModelOverride(String(value));
      handlers.setModel(String(value));
      break;
    case "provider":
      session.setProviderOverride(String(value));
      break;
    case "thinking":
      handlers.setThinking(Boolean(value));
      break;
    case "incognito":
      await session.setIncognito(Boolean(value));
      break;
    case "debug":
      session.debug = Boolean(value);
      break;
    case "theme":
      // Persisted only — theming UI lands in #43.
      break;
  }
}

async function handleSettingsCommand(
  parts: string[],
  session: Session,
  handlers: SlashHandlers,
  lines: string[],
  result: (
    action?: SlashCommandAction,
    display?: SlashCommandDisplay,
    toastTone?: SlashCommandToastTone,
  ) => SlashCommandResult,
): Promise<SlashCommandResult> {
  const sub = (parts[1] ?? "").toLowerCase();

  if (!sub) {
    const loaded = loadUserSettings();
    const persisted = loaded.settings;
    const effective = sessionEffectiveSettings(session, handlers);
    lines.push(`Persistent settings (${getUserSettingsPath()}):`);
    if (loaded.warning) lines.push(`⚠ ${loaded.warning}`);
    for (const key of USER_SETTINGS_KEYS) {
      const p = formatSettingValue(persisted[key]);
      const e = effective[key] === "" ? "(empty)" : effective[key];
      const marker = p !== e && key !== "theme" ? "  [session differs]" : "";
      lines.push(`  ${key}=${p}  (session: ${e})${marker}`);
    }
    lines.push("");
    lines.push("Usage:");
    lines.push("  /settings set <key> <value>  — persist and apply");
    lines.push("  /settings reset              — restore defaults");
    lines.push(
      `Keys: ${USER_SETTINGS_KEYS.join(", ")}. Session /model /thinking /incognito /debug do not auto-persist.`,
    );
    return result("none", "transcript");
  }

  if (sub === "reset") {
    const reset = resetUserSettings();
    if (!reset.ok) {
      lines.push(`Failed to reset settings: ${reset.error}`);
      return result("none", "toast", "error");
    }
    for (const key of USER_SETTINGS_KEYS) {
      await applySettingToSession(session, handlers, key, reset.settings[key]);
    }
    lines.push("Settings reset to defaults and applied to this session.");
    for (const key of USER_SETTINGS_KEYS) {
      lines.push(`  ${key}=${formatSettingValue(reset.settings[key])}`);
    }
    return result("refresh_status", "toast", "success");
  }

  if (sub === "set") {
    const key = parts[2]?.toLowerCase() ?? "";
    const rawValue = parts.slice(3).join(" ").trim();
    if (!key || !rawValue) {
      lines.push("Usage: /settings set <key> <value>");
      lines.push(`Keys: ${USER_SETTINGS_KEYS.join(", ")}`);
      return result("none", "toast", "error");
    }
    if (!isUserSettingsKey(key)) {
      lines.push(`Unknown setting "${key}". Keys: ${USER_SETTINGS_KEYS.join(", ")}`);
      return result("none", "toast", "error");
    }
    const parsed = parseSettingsSetValue(key, rawValue);
    if (!parsed.ok) {
      lines.push(parsed.error);
      return result("none", "toast", "error");
    }
    const patch: Partial<UserSettings> = { [key]: parsed.value };
    const updated = updateUserSettings(patch);
    if (!updated.ok) {
      lines.push(`Failed to save settings: ${updated.error}`);
      return result("none", "toast", "error");
    }
    await applySettingToSession(session, handlers, key, parsed.value);
    lines.push(`Saved ${key}=${formatSettingValue(parsed.value)} (persisted + applied).`);
    return result("refresh_status", "toast", "success");
  }

  lines.push("Usage: /settings | /settings set <key> <value> | /settings reset");
  return result("none", "toast", "error");
}

function appendModelSwitchLog(
  session: Session,
  entry: {
    provider: string;
    model: string;
    userInput: string;
    outcome: ModelSwitchOutcome;
    reason?: string;
  },
): void {
  session.eventLog.append({
    kind: "system_note",
    actor: "kernel",
    payload: {
      type: "model_switch",
      provider: entry.provider,
      model: entry.model,
      userInput: entry.userInput,
      outcome: entry.outcome,
      ...(entry.reason ? { reason: entry.reason } : {}),
    },
  });

  const details: Record<string, unknown> = {
    provider: entry.provider,
    model: entry.model,
    userInput: entry.userInput,
    outcome: entry.outcome,
  };
  if (entry.reason) details.reason = entry.reason;

  const log = session.getLogger().child("session");
  if (entry.outcome === "failed") {
    log.warn("Model switch failed", { details });
  } else if (entry.outcome === "already_on") {
    log.info("Model switch skipped (already on target)", { details });
  } else {
    log.info("Model switch succeeded", { details });
  }
}

export async function executeSlashCommand(
  input: string,
  session: Session,
  handlers: {
    setModel: (m?: string) => void;
    setThinking: (v: boolean) => void;
    getThinking: () => boolean;
    /** When provided and true, /clear and /new refuse to run to avoid state corruption mid-turn. */
    isTurnActive?: () => boolean;
  }
): Promise<SlashCommandResult> {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const lines: string[] = [];

  const result = (
    action: SlashCommandAction = "none",
    display: SlashCommandDisplay = "transcript",
    toastTone?: SlashCommandToastTone,
  ): SlashCommandResult => ({
    action,
    lines,
    display,
    toastTone,
  });

  // Defense-in-depth: the TUI disables input during a turn, but if a caller
  // ever reaches /clear or /new mid-turn, refuse rather than wipe state that
  // the running turn is still appending to.
  if ((cmd === "/clear" || cmd === "/new") && handlers.isTurnActive?.()) {
    lines.push("A turn is still running. Interrupt it first (Esc Esc), then retry.");
    return result("none", "toast", "error");
  }

  switch (cmd) {
    case "/exit":
    case "/quit": {
      lines.push("Ending session...");
      return result("exit", "toast");
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

    case "/plan": {
      const sub = parts[1]?.toLowerCase();
      if (sub === "execute" || sub === "off" || sub === "go") {
        session.exitPlanMode();
        lines.push("Plan mode off — mutating tools are allowed.");
      } else if (sub === "on") {
        session.enterPlanMode();
        lines.push("Plan mode on — mutating tools are blocked until you approve the plan.");
      } else {
        lines.push(`Plan mode: ${session.isPlanMode() ? "ON" : "OFF"}`);
        lines.push("Usage: /plan <on|off|execute>");
        return result("refresh_status", "toast", "info");
      }
      return result("refresh_status", "toast");
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
        lines.push("", "Cognitive Memory (SQLite):");
        lines.push(`  Total memories: ${persistentCount ?? "(unavailable)"}`);
        lines.push(`  Memory DB: ${session.getMemoryDbPath() ?? "(unknown)"}`);
      }

      lines.push("", `Native addon: ${session.nativeStatus ? nativeStatusToString(session.nativeStatus) : "unknown"}`);
      lines.push(`Search (fff): ${session.fffStatus ?? "unknown"}`);

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

        const compileMetrics = session.getLastCompileMetrics();
        if (compileMetrics) {
          const engineConfig = resolveContextEngineConfig(session.config);
          const contextWindow = session.getContextWindowTokens();
          const weightedRatio = session.getLastPressureRatio();
          const ratioMode = resolveEnginePressureMode(
            weightedRatio,
            engineConfig.pressure,
          );
          lines.push("", "Context pressure (last compile):");
          if (compileMetrics.taskType) {
            lines.push(`  Task type: ${compileMetrics.taskType}`);
          }
          lines.push(
            ...formatContextPressureStats(
              {
                weightedTokens: session.getLastWeightedTokens(),
                weightedRatio,
                rawTokens: compileMetrics.totalTokens,
                rawRatio: session.getLastRawPressureRatio(),
                effectiveMode: session.getLastPressureMode(),
                ratioMode,
              },
              contextWindow,
            ),
          );
        }
      }

      // Scorecard section (when available)
      if (session.isScorecardEnabled()) {
        const counters = session.scorecard.getCounters();
        if (scorecardHasData(counters)) {
          lines.push(
            "",
            ...formatScorecardLines({
              counters,
              recallUsed: session.getRecallUsedCount(),
              memory: session.scorecard.getMemorySnapshot(),
              engineOn: session.getScorecardEngineOn(),
            }),
          );
        }
      }
      break;
    }

    case "/scorecard": {
      if (!session.isScorecardEnabled()) {
        lines.push(
          "Scorecard is not active. Enable context_engine or set measurement_mode = true in praana.config.toml.",
        );
        break;
      }
      const counters = session.scorecard.getCounters();
      if (!scorecardHasData(counters)) {
        lines.push("No scorecard data yet this session.");
        break;
      }
      lines.push(
        "",
        ...formatScorecardLines({
          counters,
          recallUsed: session.getRecallUsedCount(),
          memory: session.scorecard.getMemorySnapshot(),
          engineOn: session.getScorecardEngineOn(),
        }),
        "",
        `  DB         ${resolveContextDbPath(session.config, session.cwd)}`,
      );
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
                      : ev.kind === "system_note" &&
                          ev.payload.type === "error"
                        ? `Error: ${String(ev.payload.message).slice(0, 60)}`
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
        const recallResult = await session.memoryStore.recall(query, {
          limit: 20,
          minMatch: session.config.compiler.recall_min_score ?? 0.35,
        });
        if (recallResult.notice) {
          lines.push(recallResult.notice);
        }
        if (recallResult.entries.length === 0) {
          if (!recallResult.notice) {
            lines.push("No results found.");
          }
        } else {
          lines.push(``, `Recall results for "${query}":`);
          for (const e of recallResult.entries) {
            lines.push(
              `  - [${e.kind}] ${e.content.slice(0, 100)} (match: ${e.match.toFixed(2)} | valid: ${e.validity.toFixed(2)} | useful: ${e.usefulness.toFixed(2)})`
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
      const normalizedCwd = resolve(session.cwd);
      const dirs = readdirSync(logDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      type SessionRow = {
        id: string;
        startedAt: number;
        activityAt: number;
        cwdLabel: string;
        events: number;
      };
      const rows: SessionRow[] = [];
      for (const d of dirs) {
        const sessionDir = join(logDir, d.name);
        migrateLegacyEventLog(sessionDir);
        const eventsPath = join(sessionDir, EVENT_LOG_FILENAME);
        const metaPath = join(logDir, d.name, "meta.json");
        let events = 0;
        let cwdLabel = "?";
        let startedAt = 0;
        let metaCwd: string | null = null;
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          metaCwd = typeof meta.cwd === "string" ? meta.cwd : null;
          cwdLabel = meta.cwd?.split("/").pop() ?? meta.cwd ?? "?";
          startedAt = typeof meta.started_at === "number" ? meta.started_at : 0;
        } catch {
          /* ignore */
        }
        if (!metaCwd || resolve(metaCwd) !== normalizedCwd) continue;
        try {
          const content = readFileSync(eventsPath, "utf-8");
          events = content.split("\n").filter(Boolean).length;
        } catch {
          /* ignore */
        }
        rows.push({
          id: d.name,
          startedAt,
          activityAt: sessionActivityAt(logDir, d.name, startedAt),
          cwdLabel,
          events,
        });
      }
      rows.sort((a, b) => b.activityAt - a.activityAt || b.id.localeCompare(a.id));
      const recent = rows.slice(0, 15);
      if (recent.length === 0) {
        lines.push("No sessions found for this directory.");
        break;
      }
      lines.push("", "Recent sessions (this directory):");
      for (const row of recent) {
        const time =
          row.startedAt > 0
            ? new Date(row.startedAt).toISOString().slice(0, 16).replace("T", " ")
            : "?";
        const marker = row.id === session.id ? " ← current" : "";
        lines.push(
          `  ${time}  ${row.id}  ${String(row.events).padStart(4)} events  ${row.cwdLabel}${marker}`
        );
      }
      lines.push("", "Resume with: praana resume  (last session here)");
      lines.push("Or: praana resume <session-id>");
      break;
    }

    case "/model": {
      const parsed = parseModelCommandArgs(parts);
      if (parsed.kind === "help") {
        return result("open_model_selector");
      }

      const resolved = await resolveModelSpecifier(
        parsed.modelSpec,
        session.getEffectiveProvider(),
        parsed.explicitProvider,
      ).catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : "Failed to resolve model";
        appendModelSwitchLog(session, {
          provider: parsed.explicitProvider ?? session.getEffectiveProvider(),
          model: parsed.modelSpec,
          userInput: parsed.userInput,
          outcome: "failed",
          reason: message,
        });
        lines.push(`Model lookup failed: ${message}`);
        return null;
      });
      if (!resolved) {
        return result("none", "toast", "error");
      }

      const targetProvider = resolved.provider;
      const targetModel = resolved.modelId;

      if (!resolved.known) {
        appendModelSwitchLog(session, {
          provider: targetProvider,
          model: targetModel,
          userInput: parsed.userInput,
          outcome: "failed",
          reason: "unknown_model",
        });
        lines.push(`Unknown model ID: ${parsed.userInput}`);
        return result("none", "toast", "error");
      }

      const currentProvider = session.getEffectiveProvider();
      const targetLabel = resolvedTargetLabel(resolved, currentProvider);
      if (targetLabel === session.getActiveModelLabel()) {
        appendModelSwitchLog(session, {
          provider: targetProvider,
          model: targetModel,
          userInput: parsed.userInput,
          outcome: "already_on",
        });
        handlers.setModel(resolved.modelId);
        const contextWindow = session.getContextWindowTokens(resolved.modelId);
        lines.push(
          `Already on: ${targetLabel} (${contextWindow.toLocaleString()} ctx)`,
        );
        return result("none", "toast", "info");
      }

      if (resolved.switchedProvider) {
        const keyError = getProviderConfigurationError(resolved.provider);
        if (keyError) {
          appendModelSwitchLog(session, {
            provider: targetProvider,
            model: targetModel,
            userInput: parsed.userInput,
            outcome: "failed",
            reason: keyError,
          });
          const envVarName = getProviderEnvKey(resolved.provider);
          const hint = envVarName
            ? ` (set ${envVarName} in your shell or .env file)`
            : "";
          lines.push(`${keyError}${hint}`);
          return result("none", "toast", "error");
        }
        session.setProviderOverride(resolved.provider);
      }

      if (resolved.switchedProvider) {
        // Append provider_override before model_override so forward-replay
        // order matches intent: first switch provider, then set model.
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "provider_override",
            provider: resolved.provider,
          },
        });
      }
      session.setModelOverride(resolved.modelId);
      handlers.setModel(resolved.modelId);
      const contextWindow = await session.refreshModelContextWindow(resolved.modelId);

      appendModelSwitchLog(session, {
        provider: targetProvider,
        model: targetModel,
        userInput: parsed.userInput,
        outcome: "success",
      });
      session.eventLog.append({
        kind: "system_note",
        actor: "kernel",
        payload: {
          type: "model_override",
          provider: targetProvider,
          model: resolved.modelId,
        },
      });
      lines.push(
        `Switched to: ${session.getActiveModelLabel()} (${contextWindow.toLocaleString()} ctx)`,
      );
      return result("refresh_status", "toast", "success");
    }

    case "/debug": {
      session.debug = !session.debug;
      lines.push(
        `Debug mode: ${session.debug ? "ON" : "OFF"}` +
          ` (prompts saved to ${session.promptDir}` +
          `${session.isContextEngineEnabled() ? ", scores to scores.jsonl" : ""})`
      );
      return result("refresh_status", "toast");
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
      return result("refresh_status", "toast");
    }

    case "/reasoning": {
      const levels = REASONING_EFFORT_LEVELS.join("|");
      const arg = (parts[1] ?? "").toLowerCase();
      if (!arg) {
        lines.push(`Reasoning effort: ${session.getEffectiveReasoningEffort()}`);
        lines.push(`Usage: /reasoning <${levels}>`);
        lines.push("Also accepts none (alias for off). Display-only: /thinking.");
        return result("refresh_status", "toast");
      }
      const parsed = parseReasoningEffort(arg);
      if (!parsed) {
        lines.push(`Unknown effort "${arg}". Usage: /reasoning <${levels}>`);
        return result("none", "toast", "error");
      }
      session.setReasoningEffortOverride(parsed);
      lines.push(`Reasoning effort set to ${parsed}.`);
      return result("refresh_status", "toast", "success");
    }

    case "/incognito": {
      const arg = (parts[1] ?? "").toLowerCase();
      if (!arg) {
        lines.push(`Incognito: ${session.isIncognito() ? "ON" : "OFF"}`);
        lines.push("Usage: /incognito <on|off>");
        return result("none", "toast");
      }
      if (arg === "on") {
        await session.setIncognito(true);
        lines.push("Incognito enabled — Cognitive Memory disabled.");
      } else if (arg === "off") {
        await session.setIncognito(false);
        lines.push(
          session.memoryEnabled
            ? "Incognito disabled — Cognitive Memory enabled."
            : "Incognito disabled — memory remains unavailable (check config.memory.enabled)."
        );
      } else {
        lines.push("Usage: /incognito <on|off>");
        break;
      }
      return result("refresh_status", "toast");
    }

    case "/settings": {
      return await handleSettingsCommand(parts, session, handlers, lines, result);
    }

    case "/clear": {
      session.clearState();
      session.logResetBoundary("/clear");
      session.contextEngine?.resetContext();
      session.recalculateContextBaseline();
      session.persistStateGraphCheckpoint();
      lines.push("In-session context cleared. Session ID unchanged.");
      return result("clear_transcript", "toast", "success");
    }

    case "/new": {
      lines.push("Starting a new session…");
      return result("new_session", "toast", "info");
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

    case "/memory": {
      const sub = (parts[1] ?? "").toLowerCase();
      if (sub !== "dedupe") {
        lines.push("Usage: /memory dedupe");
        break;
      }
      if (!session.memoryEnabled || !session.memoryStore) {
        lines.push("Memory dedupe requires memory to be enabled.");
        break;
      }
      try {
        const result = await session.runMemoryDedupe();
        lines.push(
          `Merged ${result.clustersMerged} duplicate ${result.clustersMerged === 1 ? "cluster" : "clusters"}, removed ${result.entriesRemoved} ${result.entriesRemoved === 1 ? "entry" : "entries"}.`,
        );
        if (session.digest) {
          lines.push("", "Digest refreshed.");
        }
      } catch (err) {
        lines.push(`Memory dedupe error: ${(err as Error).message}`);
      }
      break;
    }

    case "/login": {
      const provider = parts[1]?.toLowerCase().trim();
      lines.push(
        provider
          ? `Opening login wizard for ${provider}…`
          : "Opening login wizard…",
      );
      return {
        action: "open_login_wizard",
        lines,
        display: "toast",
        loginProviderHint: provider || undefined,
      };
    }

    case "/logout": {
      const provider = parts[1]?.toLowerCase().trim();
      const stored = listStoredProviders();

      if (!provider) {
        if (stored.length === 0) {
          lines.push("No providers logged in.");
          return result("none", "toast", "info");
        }
        // Has stored providers → open the interactive logout wizard
        lines.push("Opening logout wizard…");
        return {
          action: "open_logout_wizard",
          lines,
          display: "toast",
        };
      }

      // Specific provider requested
      const hasStored = stored.includes(provider);
      const isDeclared = isUserDeclaredProvider(provider);

      if (!hasStored && !isDeclared) {
        lines.push(`No credentials found for "${provider}".`);
        return result("none", "toast", "error");
      }

      const outcome = logoutProvider(provider, session);
      if (!outcome.removed && !outcome.sectionRemoved) {
        lines.push(...outcome.lines);
        return result("none", "toast", "info");
      }

      if (outcome.switchedTo) {
        handlers.setModel(outcome.switchedTo.model || undefined);
      }

      lines.push(...outcome.lines);
      if (outcome.needsLogin) {
        return {
          action: "open_login_wizard",
          lines,
          display: "toast",
          toastTone: "info",
        };
      }
      return result("refresh_status", "toast", "success");
    }

    case "/setup": {
      lines.push("Opening setup wizard…");
      return {
        action: "open_setup_wizard",
        lines,
        display: "toast",
      };
    }

    case "/shell": {
      const command = parts.slice(1).join(" ");
      if (!command) {
        lines.push("Usage: /shell <command>");
        return result("none", "toast", "error");
      }

      const runResult = await executeShellCommand({
        command,
        cwd: session.cwd,
        sandbox: session.config.shell,
        timeout: 30000,
      });

      lines.push(`$ ${command}`);
      if (runResult.stdout) lines.push(...runResult.stdout.split("\n"));
      if (runResult.stderr) lines.push(...runResult.stderr.split("\n"));
      if (!runResult.ok && !runResult.stdout && !runResult.stderr) {
        lines.push(runResult.stderr || `Command failed with exit code ${runResult.exitCode}`);
      } else if (runResult.exitCode !== 0) {
        lines.push(`exit code: ${runResult.exitCode}`);
      }

      return {
        action: "none",
        lines,
        display: "inline_transcript",
        toastTone: runResult.ok ? undefined : "error",
        shellRun: {
          command,
          stdout: runResult.stdout,
          stderr: runResult.stderr,
          exitCode: runResult.exitCode,
          ok: runResult.ok,
        },
      };
    }

    case "/help": {
      return { action: "none", lines: bannerHelpLines() };
    }

    default:
      lines.push(`Unknown command: ${cmd}. Type /help for available commands.`);
      return result("none", "toast");
  }

  return result();
}
