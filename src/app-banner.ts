import chalk from "chalk";
import boxen from "boxen";
import { readFileSync } from "node:fs";
import { getLoadedConfigSources } from "./config.js";
import {
  APP_NAME,
  APP_TAGLINE,
  CLI_NAME,
  CLI_SHORT,
} from "./app-identity.js";
import type { Session } from "./session.js";

export const APP_VERSION = readAppVersion();

function readAppVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf-8")) as { version?: string };
    return pkg.version ? `v${pkg.version}` : "v0.0.0";
  } catch {
    return "v0.0.0";
  }
}

export function formatSessionBannerLines(
  session: Session,
  cwd: string,
  model: string
): string[] {
  const memoryStats = session.getMemoryStats();
  const digestLen = session.digest?.length ?? 0;
  const configSources = getLoadedConfigSources();
  return [
    `${APP_NAME} ${APP_VERSION}`,
    `session: ${session.id}`,
    `cwd: ${cwd}`,
    `model: ${model}`,
    ...(configSources.length > 0
      ? [`config: ${configSources.join(" → ")}`]
      : [`config: defaults`]),
    `memory entries: ${memoryStats.total}`,
    `digest chars: ${digestLen}`,
    session.memoryEnabled
      ? `memory db: ${session.getMemoryDbPath() ?? "(unknown)"}`
      : session.isIncognito()
        ? "memory: incognito (disabled)"
        : "memory: disabled",
  ];
}

export function printSessionBanner(session: Session, cwd: string, model: string): void {
  const W = 72;
  const title = `▲ ${APP_NAME} [` + APP_VERSION + "]";
  console.log(title + " " + "─".repeat(W - title.length - 2) + "┐");
  const tagline = APP_TAGLINE;
  console.log("│ " + chalk.dim(tagline) + " ".repeat(W - 3 - tagline.length) + "│");
  console.log("└" + "─".repeat(W - 2) + "┘");
}

/** Prefix length for resume hints — long enough to disambiguate current ULIDs. */
export const RESUME_ID_PREFIX_LEN = 12;

export type SessionEndEpilogueInput = {
  sessionId: string;
  memory: "completed" | "background" | "skipped" | "failed" | "noop";
  turns: number;
  stateObjects: number;
  rememberCalls: number;
  recallUsed: number;
  /** Summarizer learnings stored in-process; omit/0 when background or unknown. */
  learningsStored: number;
};

/**
 * Single post-/exit epilogue (issue #181). Honest labels, no duplicate footer,
 * outcome counts only when > 0.
 */
export function formatSessionEndEpilogue(input: SessionEndEpilogueInput): string[] {
  const shortId = input.sessionId.slice(0, RESUME_ID_PREFIX_LEN);
  const turnLabel = input.turns === 1 ? "1 turn" : `${input.turns} turns`;
  const stateLabel =
    input.stateObjects === 1 ? "1 state object" : `${input.stateObjects} state objects`;

  const lines: string[] = [
    "",
    ` session saved · ${turnLabel} · ${stateLabel}`,
    ` resume: ${CLI_NAME} resume ${shortId}`,
  ];

  const memoryParts: string[] = [];
  if (input.memory === "completed") {
    memoryParts.push("memory saved");
  } else if (input.memory === "background") {
    memoryParts.push("saving in background…");
  } else if (input.memory === "failed") {
    memoryParts.push("memory failed");
  } else {
    memoryParts.push("memory off");
  }

  if (input.rememberCalls > 0) {
    memoryParts.push(`remembered ${input.rememberCalls}`);
  }
  if (input.recallUsed > 0) {
    memoryParts.push(`reinforced ${input.recallUsed}`);
  }
  // Only claim learnings when the summarizer finished in-process.
  if (input.memory === "completed" && input.learningsStored > 0) {
    memoryParts.push(`learned ${input.learningsStored}`);
  }

  lines.push(` ${memoryParts.join(" · ")}`);
  lines.push("");
  return lines;
}

/** @deprecated Prefer formatSessionEndEpilogue — kept for any external callers. */
export function formatSessionEndSummary(session: Session): string {
  const summary = session.getSessionSummary();
  return formatSessionEndEpilogue({
    sessionId: session.id,
    memory: session.memoryEnabled ? "completed" : "skipped",
    turns: summary.turns,
    stateObjects: summary.stateObjects,
    rememberCalls: summary.memoriesStored,
    recallUsed: 0,
    learningsStored: 0,
  })
    .filter((l) => l.trim().length > 0)
    .join(" · ");
}

/** Resume hint printed after the TUI exits (OpenCode-style epilogue). */
export function formatSessionEpilogue(sessionId: string): string[] {
  return [
    "",
    `  ${CLI_NAME} resume`,
    `  ${CLI_SHORT} resume`,
    `  ${CLI_NAME} resume ${sessionId}`,
    `  ${CLI_SHORT} resume ${sessionId}`,
    "",
  ];
}

export function printSessionEndSummary(session: Session): void {
  for (const line of formatSessionEndEpilogue({
    sessionId: session.id,
    memory: session.memoryEnabled ? "completed" : "skipped",
    turns: session.getSessionSummary().turns,
    stateObjects: session.getSessionSummary().stateObjects,
    rememberCalls: session.getSessionSummary().memoriesStored,
    recallUsed: 0,
    learningsStored: 0,
  })) {
    console.log(line);
  }
}

function usageLines(): string[] {
  return [
    `  ${CLI_NAME}                     Start new session in current directory`,
    `  ${CLI_SHORT}                      Short alias for ${CLI_NAME}`,
    `  ${CLI_NAME} setup               Configure provider interactively`,
    `  ${CLI_NAME} doctor              Check setup and provider configuration`,
    `  ${CLI_NAME} --providers [--all]  List supported providers (--all includes pi-ai extras)`,
    `  ${CLI_NAME} resume [session]   Resume last session here, or a specific session`,
    `  ${CLI_NAME} memory dedupe       Merge near-duplicate cognitive memories`,
    `  ${CLI_NAME} --debug             Start with debug mode enabled`,
    `  ${CLI_NAME} --incognito         Start without Cognitive Memory persistence`,
    `  ${CLI_NAME} -I                  Short alias for --incognito`,
    `  ${CLI_NAME} --config <path>     Load config from specific .json/.toml path`,
    `  ${CLI_NAME} --version           Show version`,
    `  ${CLI_NAME} --help              Show this help`,
  ];
}

export function getHelpLines(): string[] {
  return [
    chalk.bold(`  ${APP_NAME} — ${APP_TAGLINE}`),
    "",
    "Usage:",
    ...usageLines(),
    "",
    "Slash Commands:",
    "  /exit                    End session and save",
    "  /state                   List all state objects for this session",
    "  /stats                   Show session, working-memory, and Cognitive Memory stats",
    "  /scorecard               Show per-session telemetry scorecard (issue #99)",
    "  /digest                  Print Cognitive Memory digest",
    "  /events                  Show last 20 events",
    "  /recall <query>          Search Cognitive Memory",
    "  /memory dedupe           Merge near-duplicate Cognitive Memory entries",
    "  /setup                   Configure provider interactively",
    "  /model [provider] <id>   Switch model (e.g., gpt-4o or openai gpt-4o)",
    "  /sessions                List recent sessions",
    "  /shell <command>         Run a shell command directly",
    "  !<command>               Shortcut for /shell <command>",
    "  /debug                   Toggle debug mode (tool blocks + saved prompts)",
    "  /why <unit-id>           Explain last compile score for a context unit",
    "  /thinking <on|off>       Toggle thinking stream visibility",
    "  /incognito <on|off>      Toggle Cognitive Memory persistence",
    "  /clear                   Reset in-session context (same session ID)",
    "  /new                     Start a new session (reload config)",
    "",
    "  Status bar: model, context, mode, repo, memory tiers, skills, task",
    "  Esc Esc                  Interrupt a running turn (Ctrl+C also works)",
    "  /help                    Show this help",
    "",
    "Tip: ~/.praana/AGENTS.md — global personal instructions loaded every session",
  ];
}

export function printHelp(): void {
  const usage = usageLines().join("\n");
  const commands = [
    "  /exit                    End session and save",
    "  /state                   List all state objects for this session",
    "  /stats                   Show session, working-memory, and Cognitive Memory stats",
    "  /scorecard               Show per-session telemetry scorecard (issue #99)",
    "  /digest                  Print Cognitive Memory digest",
    "  /events                  Show last 20 events",
    "  /recall <query>          Search Cognitive Memory",
    "  /memory dedupe           Merge near-duplicate Cognitive Memory entries",
    "  /setup                   Configure provider interactively",
    "  /model [provider] <id>   Switch model (e.g., gpt-4o or openai gpt-4o)",
    "  /sessions                List recent sessions",
    "  /shell <command>         Run a shell command directly",
    "  !<command>               Shortcut for /shell <command>",
    "  /debug                   Toggle debug mode (tool blocks + saved prompts)",
    "  /why <unit-id>           Explain last compile score for a context unit",
    "  /thinking <on|off>       Toggle thinking stream visibility",
    "  /incognito <on|off>      Toggle Cognitive Memory persistence",
    "  /clear                   Reset in-session context (same session ID)",
    "  /new                     Start a new session (reload config)",
    "",
    "  Status bar (above prompt): model, context, mode, repo, memory tiers, skills, task",
    "  Esc Esc                  Interrupt a running turn (Ctrl+C also works)",
    "  /help                    Show this help",
    "",
    "  Tip: ~/.praana/AGENTS.md — global personal instructions loaded every session",
  ].join("\n");
  console.log(
    chalk.bold(`  ${APP_NAME} — ${APP_TAGLINE}`) +
      "\n\n" +
      boxen(usage, {
        padding: { top: 0, bottom: 0, left: 0, right: 0 },
        margin: { top: 0, bottom: 1, left: 0, right: 0 },
        borderStyle: "round",
        borderColor: "cyan",
        title: "Usage",
        titleAlignment: "left",
      }) +
      boxen(commands, {
        padding: { top: 0, bottom: 0, left: 0, right: 0 },
        margin: { top: 0, bottom: 1, left: 0, right: 0 },
        borderStyle: "round",
        borderColor: "green",
        title: "Slash Commands",
        titleAlignment: "left",
      })
  );
}

export function formatRecentConversationLines(session: Session, maxMessages = 6): string[] {
  // Cap the scan: we only need the most recent post-boundary user/agent turns.
  // 30 events per visible message is a generous upper bound for tool-heavy turns.
  const scanCap = maxMessages * 30;
  const recentEvents = session.eventLog.readLastUncompressedAfterResetBoundary(scanCap);
  const turns = recentEvents.filter(
    (e) => e.kind === "user_message" || e.kind === "agent_message"
  );
  if (turns.length === 0) return [];

  const lines: string[] = [
    "─".repeat(50),
    `  📜  Recent conversation (${Math.min(turns.length, maxMessages)} of ${turns.length} messages)`,
    "─".repeat(50),
  ];
  const shown = turns.slice(-maxMessages);
  for (const ev of shown) {
    const prefix = ev.kind === "user_message" ? "You" : APP_NAME;
    const text = (ev.payload.text as string)?.trim() ?? "";
    const displayLines = text.split("\n").slice(0, 2).join(" ");
    const display =
      displayLines.length > 150 ? displayLines.slice(0, 147) + "..." : displayLines;
    lines.push(`  ${prefix}: ${display}`);
  }
  lines.push("─".repeat(50));
  return lines;
}
