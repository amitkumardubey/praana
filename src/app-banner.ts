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

export function formatSessionEndSummary(session: Session): string {
  const summary = session.getSessionSummary();
  return `Session ended: ${summary.turns} turns, ${summary.stateObjects} state objects, ${summary.memoriesStored} memories stored`;
}

/** Resume hint printed after the TUI exits (OpenCode-style epilogue). */
export function formatSessionEpilogue(sessionId: string): string[] {
  return ["", `  ${CLI_NAME} resume ${sessionId}`, `  ${CLI_SHORT} resume ${sessionId}`, ""];
}

export function printSessionEndSummary(session: Session): void {
  console.log(formatSessionEndSummary(session));
}

function usageLines(): string[] {
  return [
    `  ${CLI_NAME}                     Start new session in current directory`,
    `  ${CLI_SHORT}                      Short alias for ${CLI_NAME}`,
    `  ${CLI_NAME} init                Create a default config file`,
    `  ${CLI_NAME} init --force        Overwrite existing config file`,
    `  ${CLI_NAME} resume <session>    Resume an existing session`,
    `  ${CLI_NAME} --ui tui            Start with Ink TUI (default when TTY)`,
    `  ${CLI_NAME} --ui readline       Classic readline interface`,
    `  ${CLI_NAME} --screen alternate  Full-screen TUI (fixed viewport)`,
    `  ${CLI_NAME} --debug             Start with debug mode enabled`,
    `  ${CLI_NAME} --incognito         Start without cross-session memory persistence`,
    `  ${CLI_NAME} -I                  Short alias for --incognito`,
    `  ${CLI_NAME} --config <path>     Load config from specific .json/.toml path`,
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
    "  /stats                   Show session, working-memory, and persistent-memory stats",
    "  /digest                  Print cross-session memory digest",
    "  /events                  Show last 20 events",
    "  /recall <query>          Search cross-session knowledge base",
    "  /model [provider] <id>   Switch model (e.g., gpt-4o or openai gpt-4o)",
    "  /sessions                List recent sessions",
    "  /debug                   Toggle debug mode (tool blocks + saved prompts)",
    "  /why <unit-id>           Explain last compile score for a context unit",
    "  /thinking <on|off>       Toggle thinking stream visibility",
    "  /incognito <on|off>      Toggle cross-session memory persistence",
    "  /clear                   Clear working-memory state",
    "  /new                     Clear working-memory state",
    "",
    "  Status bar: model, context, mode, repo, memory tiers, skills, task",
    "  Esc Esc                  Interrupt a running turn (Ctrl+C also works)",
    "  /help                    Show this help",
  ];
}

export function printHelp(): void {
  const usage = usageLines().join("\n");
  const commands = [
    "  /exit                    End session and save",
    "  /state                   List all state objects for this session",
    "  /stats                   Show session, working-memory, and persistent-memory stats",
    "  /digest                  Print cross-session memory digest",
    "  /events                  Show last 20 events",
    "  /recall <query>          Search cross-session knowledge base",
    "  /model [provider] <id>   Switch model (e.g., gpt-4o or openai gpt-4o)",
    "  /sessions                List recent sessions",
    "  /debug                   Toggle debug mode (tool blocks + saved prompts)",
    "  /why <unit-id>           Explain last compile score for a context unit",
    "  /thinking <on|off>       Toggle thinking stream visibility",
    "  /incognito <on|off>      Toggle cross-session memory persistence",
    "  /clear                   Clear working-memory state",
    "  /new                     Clear working-memory state",
    "",
    "  Status bar (above prompt): model, context, mode, repo, memory tiers, skills, task",
    "  Esc Esc                  Interrupt a running turn (Ctrl+C also works)",
    "  /help                    Show this help",
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
  const recentEvents = session.eventLog.readLast(30);
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
