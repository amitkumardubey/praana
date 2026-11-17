import chalk from "chalk";
import boxen from "boxen";
import { readFileSync } from "node:fs";
import { getLoadedConfigSources } from "./config.js";
import {
  APP_NAME,
  APP_TAGLINE,
  CLI_NAME,
} from "./app-identity.js";
import type { Session } from "./session.js";
import { nativeStatusToString } from "./native/index.js";

export const APP_VERSION = readAppVersion();

/** Injected by `scripts/compile.ts` via Bun.build `define`; unset when running from source. */
declare const PRAANA_BUILD_VERSION: string | undefined;

function readAppVersion(): string {
  if (typeof PRAANA_BUILD_VERSION === "string" && PRAANA_BUILD_VERSION.length > 0) {
    return PRAANA_BUILD_VERSION.startsWith("v")
      ? PRAANA_BUILD_VERSION
      : `v${PRAANA_BUILD_VERSION}`;
  }
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf-8")) as { version?: string };
    return pkg.version ? `v${pkg.version}` : "v0.0.0";
  } catch {
    return "v0.0.0";
  }
}

export interface FileMemoryCounts {
  kind: "counts" | "unavailable" | "off";
  global: number;
  project: number;
  /** Files that could not be read or named (invalid names, oversize, unreadable). */
  skipped: number;
}

/** Live store counts. Does not rebuild the prompt index. */
export async function describeFileMemory(session: Session): Promise<FileMemoryCounts> {
  const empty = { global: 0, project: 0, skipped: 0 };
  if (!session.fileMemory) {
    return { kind: session.memoryError ? "unavailable" : "off", ...empty };
  }
  const listed = await session.fileMemory.list();
  if (!listed.ok) return { kind: "unavailable", ...empty };
  const global = listed.entries.filter((entry) => entry.scope === "global").length;
  const project = listed.entries.filter((entry) => entry.scope === "project").length;
  return { kind: "counts", global, project, skipped: listed.skipped };
}



export async function formatSessionBannerLines(
  session: Session,
  cwd: string,
  model: string
): Promise<string[]> {
  const memoryStats = session.getMemoryStats();
  const digestLen = session.digest?.length ?? 0;
  const configSources = getLoadedConfigSources();
  // The banner describes the start-of-session prompt index snapshot; it never
  // rescans the store, so it cannot claim counts the model does not see.
  let memoryLine: string;
  if (session.memoryError) {
    memoryLine = "memory: unavailable";
  } else if (!session.memoryEnabled) {
    memoryLine = "memory: off";
  } else {
    const promptIndex = session.getMemoryPromptIndex();
    const parts: string[] = [];
    if (promptIndex && promptIndex.total > 0) {
      parts.push(`shown ${promptIndex.shown}/${promptIndex.total}`);
    }
    if (session.isIncognito()) parts.push("incognito");
    memoryLine = `memory: ${parts.length > 0 ? parts.join(" · ") : "on"}`;
  }
  return [
    `${APP_NAME} ${APP_VERSION}`,
    `session: ${session.id}`,
    `cwd: ${cwd}`,
    `model: ${model}`,
    ...(configSources.length > 0
      ? [`config: ${configSources.join(" → ")}`]
      : [`config: defaults`]),
    `state objects: ${memoryStats.total}`,
    `digest chars: ${digestLen}`,
    ...(session.memoryError ? [`⚠ memory unavailable: ${session.memoryError}`] : []),
    memoryLine,
    session.nativeStatus ? `native: ${nativeStatusToString(session.nativeStatus)}` : `native: unknown`,
    session.fffStatus ? `search: ${session.fffStatus}` : `search: unknown`,
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
  memory: "skipped" | "noop";
  turns: number;
  stateObjects: number;
  rememberCalls: number;
  recallUsed: number;
};

/**
 * Single post-/exit epilogue (issue #519). Honest labels, no duplicate footer,
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
  memoryParts.push(input.memory === "noop" ? "file memory" : "memory off");

  if (input.rememberCalls > 0) {
    memoryParts.push(`remembered ${input.rememberCalls}`);
  }
  if (input.recallUsed > 0) {
    memoryParts.push(`recalled ${input.recallUsed}`);
  }

  lines.push(` ${memoryParts.join(" · ")}`);
  lines.push("");
  return lines;
}

/** Resume hint printed after the TUI exits (OpenCode-style epilogue). */
export function formatSessionEpilogue(sessionId: string): string[] {
  return [
    "",
    `  ${CLI_NAME} resume`,
    `  ${CLI_NAME} resume ${sessionId}`,
    "",
  ];
}

function usageLines(): string[] {
  return [
    `  ${CLI_NAME}                     Start new session in current directory`,
    `  ${CLI_NAME} setup               Configure provider interactively`,
    `  ${CLI_NAME} doctor              Check setup and provider configuration`,
    `  ${CLI_NAME} upgrade             Install the latest GitHub Release (binary + sidecar)`,
    `  ${CLI_NAME} models [provider] [--all]  List configured models (--all includes unconfigured)`,
    `  ${CLI_NAME} providers [--all]   List configured providers (--all includes unconfigured)`,
    `  ${CLI_NAME} resume [session]   Resume last session here, or a specific session`,
    `  ${CLI_NAME} run "<instruction>" [--max-steps N]  Headless one-shot (no TTY)`,
    `  ${CLI_NAME} --debug             Start with debug mode enabled`,
    `  ${CLI_NAME} --incognito         Start with memory writes blocked`,
    `  ${CLI_NAME} -I                  Short alias for --incognito`,
    `  ${CLI_NAME} --config <path>     Load config from specific .json/.toml path`,
    `  ${CLI_NAME} --version           Show version`,
    `  ${CLI_NAME} --help              Show this help`,
  ];
}

/** Slash-command help block shared by printHelp (and previously getHelpLines). */
export const SLASH_COMMANDS_HELP_BLOCK = [
  "  /exit (/quit)           End session and save",
  "  /state                   List all state objects for this session",
  "  /stats                   Show session, working-memory, and file memory counts",
  "  /scorecard               Show per-session telemetry scorecard (issue #488)",
  "  /digest                  Print the current file memory index",
  "  /events                  Show last 20 events",
  "  /recall <query>          Search file memories",
  "  /memory                  List file memories; show/forget/prune (prune lists the oldest candidates, does not delete)",
  "  /login [provider]        Add or update a provider",
  "  /logout [provider]       Remove a provider's credentials",
  "  /model [provider] <id>   Switch model (bare /model opens selector)",
  "  /plan [on|off|execute|go]  Toggle plan mode",
  "  /sessions                List recent sessions",
  "  /shell <command>         Run a shell command directly",
  "  !<command>               Shortcut for /shell <command>",
  "  /debug                   Toggle debug mode (tool blocks + saved prompts)",
  "  /why <unit-id>           Explain last compile score for a context unit",
  "  /thinking <on|off>       Toggle thinking stream visibility",
  "  /reasoning <level>       Set reasoning effort (off|minimal|low|medium|high|xhigh)",
  "  /incognito <on|off>      Block or allow memory writes",
  "  /settings                View persistent settings (set|reset)",
  "  /clear                   Reset in-session context (same session ID)",
  "  /new                     Start a new session (reload config)",
  "",
  "  Status bar (above prompt): model, context, mode, repo, memory tiers, skills, task",
  "  Ctrl+C                   Copy the selection; else interrupt a turn (idle: clear input or exit)",
  "  /help                    Show this help",
  "",
  "  Tip: ~/.praana/AGENTS.md — global personal instructions loaded every session",
];

export function printHelp(): void {
  const usage = usageLines().join("\n");
  const commands = SLASH_COMMANDS_HELP_BLOCK.join("\n");
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
