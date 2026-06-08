import * as readline from "node:readline";
import chalk from "chalk";
import boxen from "boxen";
import { startSpinner, stopSpinner, printBox, printMarkdown } from "./ui.js";
import { buildStatusBarInput, renderStatusBar } from "./status-bar.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_LOG_FILENAME, migrateLegacyEventLog } from "./event-log.js";
import { Session } from "./session.js";
import { runTurn } from "./turn.js";
import { TurnAbortedError, TurnController, EscInterruptListener } from "./turn-control.js";
import { getMissingKeyMessage } from "./llm.js";
import { loadConfig, getLoadedConfigSources } from "./config.js";
import { parseCliArgs } from "./cli-args.js";
import { createThinkingState, onThinkingDelta, closeThinking as closeThinkingBlock, toggleThinking } from "./thinking-display.js";
import type { LlmConfig } from "./types.js";

const APP_VERSION = readAppVersion();

export async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.showHelp) {
    printHelp();
    process.exit(0);
  }

  const cwd = resolve(process.cwd());
  const config = loadConfig(parsed.configPath);
  const { sessionId, resumeMode, debug, incognito } = parsed;
  const keyError = getMissingKeyMessage(config.llm.provider);
  if (keyError) {
    console.error(keyError);
    process.exit(1);
  }

  // Create or resume session
  let session: Session;
  let sessionEnded = false;
  try {
    if (resumeMode && sessionId) {
      console.log(`Resuming session: ${sessionId}`);
      session = await Session.resume(sessionId, cwd, config);
      session.debug = debug;
      
      // Print recent conversation for context
      const recentEvents = session.eventLog.readLast(30);
      const turns = recentEvents.filter(e => e.kind === "user_message" || e.kind === "agent_message");
      if (turns.length > 0) {
        console.log(`\n${'─'.repeat(50)}`);
        console.log(`  📜  Recent conversation (${Math.min(turns.length, 6)} of ${turns.length} messages)`);
        console.log('─'.repeat(50));
        const shown = turns.slice(-6);
        for (const ev of shown) {
          const prefix = ev.kind === "user_message" ? "You" : "ARIA";
          const text = (ev.payload.text as string)?.trim() ?? "";
          // Show first 2 lines, clean up
          const lines = text.split("\n").slice(0, 2).join(" ");
          const display = lines.length > 150 ? lines.slice(0, 147) + "..." : lines;
          console.log(`  ${prefix}: ${display}`);
        }
        console.log('─'.repeat(50) + "\n");
      }
    } else {
      session = await Session.create(cwd, config, { incognito });
      session.debug = debug;
      console.log(`New session: ${session.id}`);
    }
  } catch (err) {
    console.error("Failed to start session:", (err as Error).message);
    process.exit(1);
  }

  let showThinking = true;

  await printSessionBanner(session, cwd, currentModelOrDefault(session));
  console.log('Type /help for commands, /exit to quit. Esc Esc (or Ctrl+C) interrupts a running turn.');
  console.log();

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  const refreshStatusBar = () => {
    renderStatusBar(
      buildStatusBarInput(session, {
        model: currentModelOrDefault(session),
        debug: session.debug,
        thinking: showThinking,
      })
    );
  };

  refreshStatusBar();
  rl.prompt();

  let currentModel: string | undefined = session.getModelOverride() ?? undefined;
  const turnController = new TurnController();
  const escListener = new EscInterruptListener();
  let interruptHandling = false;

  const handleUserInterrupt = (): void => {
    if (interruptHandling) return;
    interruptHandling = true;
    setImmediate(() => {
      interruptHandling = false;
    });

    if (turnController.isActive()) {
      turnController.abort();
      return;
    }

    console.log("\nUse /exit to save and quit.");
    rl.prompt();
  };

  // Process-level handler prevents the default SIGINT exit (130).
  // Ora re-emits SIGINT via process.kill while stdin is in raw mode.
  process.on("SIGINT", handleUserInterrupt);

  rl.on("line", async (line: string) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // Handle slash commands
    if (input.startsWith("/")) {
      await handleSlashCommand(input, session, rl, (m) => {
        currentModel = m;
      }, (v) => {
        showThinking = v;
      }, () => showThinking);
      const slashCmd = input.split(/\s+/)[0].toLowerCase();
      if (slashCmd === "/model" || slashCmd === "/debug" || slashCmd === "/thinking") {
        refreshStatusBar();
      }
      rl.prompt();
      return;
    }

    // Regular turn
    startSpinner("thinking…");
    let spinnerStopped = false;
    const stopSpinnerOnce = () => {
      if (spinnerStopped) return;
      stopSpinner();
      spinnerStopped = true;
    };

    const thinking = createThinkingState(showThinking);
    const closeThinking = () => {
      const summary = closeThinkingBlock(thinking);
      if (summary) {
        process.stdout.write(chalk.dim(`\n${summary}\n`));
      } else {
        process.stdout.write("\n");
      }
    };

    // Toggle thinking visibility with 't' keypress during turn
    const onKeypress = (_: string, key: { name?: string }) => {
      if (key?.name === "t") {
        const nowVisible = toggleThinking(thinking);
        process.stdout.write(
          chalk.dim(nowVisible ? "\n[thinking on]" : "\n[thinking off]")
        );
        refreshStatusBar();
      }
    };
    process.stdin.on("keypress", onKeypress);

    const signal = turnController.begin();
    escListener.start(() => {
      turnController.abort();
    }, rl);

    try {
      await runTurn(session, input, currentModel, {
        signal,
        onThinkingDelta: (delta) => {
          stopSpinnerOnce();
          const { printHeader, printDelta } = onThinkingDelta(thinking, delta);
          if (!printDelta) return;
          if (printHeader) {
            process.stdout.write(chalk.dim("\n\n[thinking]\n"));
          }
          process.stdout.write(chalk.dim(delta));
        },
        onTextDelta: (delta) => {
          stopSpinnerOnce();
          closeThinking();
          process.stdout.write(delta);
        },
        onToolCallsStart: () => {
          closeThinking();
        },
      });
      closeThinking();
      stopSpinnerOnce(); // no deltas arrived (e.g. empty model response)
    } catch (err) {
      stopSpinnerOnce();
      closeThinking();
      if (err instanceof TurnAbortedError) {
        console.log(chalk.yellow("\n[interrupted]"));
      } else {
        console.error("\n[error]", (err as Error).message);
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: { type: "error", message: (err as Error).message },
        });
      }
    } finally {
      process.stdin.removeListener("keypress", onKeypress);
      escListener.stop();
      turnController.end();
    }

    console.log();
    refreshStatusBar();
    rl.prompt();
  });

  rl.on("close", async () => {
    if (!sessionEnded) {
      sessionEnded = true;
      console.log("\nShutting down...");
      const events = session.getTranscriptEvents();
      await session.end("clean", events, { memoryTimeoutMs: 5_000 });
      printSessionEndSummary(session);
    }
    process.exit(0);
  });

  // Keep readline open — without this listener Ctrl+C closes the interface.
  rl.on("SIGINT", handleUserInterrupt);
}

export async function handleSlashCommand(
  input: string,
  session: Session,
  rl: readline.Interface,
  setModel: (m?: string) => void,
  setThinking: (v: boolean) => void,
  getThinking: () => boolean
): Promise<void> {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case "/exit":
    case "/quit": {
      console.log("Ending session...");
      rl.close();
      return;
    }

    case "/state": {
      const objects = session.stateGraph.list();
      if (objects.length === 0) {
        console.log("No state objects yet this session. Use remember() or create_task() to start tracking.");
      } else {
        console.log(`\nState objects (${objects.length}):`);
        for (const o of objects) {
          const tierIcon =
            o.tier === "active" ? "●" : o.tier === "soft" ? "○" : "·";
          console.log(`  ${tierIcon} ${o.id} [${o.kind}] ${o.tier}: ${o.summary}`);
        }
      }
      break;
    }

    case "/stats": {
      const stats = session.getMemoryStats();
      const startedAt = new Date(session.getStartedAt()).toISOString();
      const uptimeSec = Math.floor(session.getUptimeMs() / 1000);
      const persistentCount = session.getPersistentMemoryEntryCount();
      console.log("\nSession:");
      console.log(`  Session ID: ${session.id}`);
      console.log(`  Turns: ${session.getTurnCount()}`);
      console.log(`  Started at: ${startedAt}`);
      console.log(`  Uptime: ${uptimeSec}s`);

      const inTokens = session.getInputTokens();
      const outTokens = session.getOutputTokens();
      if (inTokens > 0 || outTokens > 0) {
        console.log(`  Tokens (this boot): ${inTokens.toLocaleString()} in / ${outTokens.toLocaleString()} out`);
      }

      console.log("\nWorking memory (this session):");
      console.log(`  Total: ${stats.total}`);
      console.log(`  Active: ${stats.active}`);
      console.log(`  Soft: ${stats.soft}`);
      console.log(`  Hard: ${stats.hard}`);
      const kindParts = Object.entries(stats.byKind)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, count]) => `${kind}:${count}`);
      console.log(`  By kind: ${kindParts.length ? kindParts.join(", ") : "(none)"}`);

      if (session.memoryEnabled) {
        console.log("\nPersistent memory (SQLite):");
        console.log(`  Total memories: ${persistentCount ?? "(unavailable)"}`);
        console.log(`  Memory DB: ${session.getMemoryDbPath() ?? "(unknown)"}`);
      }
      break;
    }

    case "/digest": {
      if (session.digest) {
        console.log("\n" + session.digest);
      } else {
        console.log("No digest available.");
      }
      break;
    }

    case "/events": {
      const events = session.eventLog.readLast(20);
      if (events.length === 0) {
        console.log("No events yet.");
      } else {
        console.log(`\nLast ${events.length} events:`);
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
          console.log(`  ${time} ${ev.kind.padEnd(16)} ${summary}`);
        }
      }
      break;
    }

    case "/recall": {
      const query = parts.slice(1).join(" ");
      if (!query || !session.memoryEnabled || !session.memoryStore) {
        console.log("Usage: /recall <query> (requires memory enabled)");
        break;
      }
      try {
        const result = await session.memoryStore.recall(query, { limit: 20 });
        if (result.entries.length === 0) {
          console.log("No results found.");
        } else {
          console.log(`\nRecall results for "${query}":`);
          for (const e of result.entries) {
            console.log(
              `  - [${e.kind}] ${e.content.slice(0, 100)} (match: ${e.match.toFixed(2)} | conf: ${e.confidence.toFixed(2)})`
            );
          }
        }
      } catch (err) {
        console.log("Recall error:", (err as Error).message);
      }
      break;
    }

    case "/sessions": {
      const { readdirSync, readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const logDir = session.config.session.log_dir;
      if (!existsSync(logDir)) {
        console.log("No sessions directory found.");
        break;
      }
      const dirs = readdirSync(logDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .sort((a, b) => b.name.localeCompare(a.name))
        .slice(0, 15);
      if (dirs.length === 0) {
        console.log("No sessions found.");
        break;
      }
      console.log(`\nRecent sessions:`);
      for (const d of dirs) {
        const sessionDir = join(logDir, d.name);
        migrateLegacyEventLog(sessionDir);
        const eventsPath = join(sessionDir, EVENT_LOG_FILENAME);
        const metaPath = join(logDir, d.name, "meta.json");
        let events = 0, cwd = "?", time = "?";
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          cwd = meta.cwd?.split("/").pop() ?? meta.cwd ?? "?";
          time = new Date(meta.started_at).toISOString().slice(0, 16).replace("T", " ");
        } catch {}
        try {
          const content = readFileSync(eventsPath, "utf-8");
          events = content.split("\n").filter(Boolean).length;
        } catch {}
        const marker = d.name === session.id ? " ← current" : "";
        console.log(`  ${time}  ${d.name.slice(0, 12)}...  ${String(events).padStart(4)} events  ${cwd}${marker}`);
      }
      console.log(`\nResume with: npx tsx src/main.ts resume <session-id>`);
      break;
    }

    case "/model": {
      const model = parts[1];
      if (!model) {
        console.log(`Current model: ${session.getModelOverride() ?? session.config.llm.model}`);
        console.log("Usage: /model <provider/model> (e.g., /model openai/gpt-4o)");
        break;
      }
      const trimmed = model.trim();
      setModel(trimmed);
      session.setModelOverride(trimmed);
      session.eventLog.append({
        kind: "system_note",
        actor: "kernel",
        payload: {
          type: "model_override",
          model: trimmed,
        },
      });
      console.log(`Model switched to: ${model}`);
      break;
    }

    case "/debug": {
      session.debug = !session.debug;
      console.log(
        `Debug mode: ${session.debug ? "ON" : "OFF"}` +
        ` (prompts saved to ${session.promptDir})`
      );
      break;
    }

    case "/thinking": {
      const arg = (parts[1] ?? "").toLowerCase();
      if (!arg) {
        console.log(`Thinking: ${getThinking() ? "ON" : "OFF"}`);
        console.log("Usage: /thinking <on|off>");
        break;
      }
      if (arg === "on") {
        setThinking(true);
        console.log("Thinking enabled.");
      } else if (arg === "off") {
        setThinking(false);
        console.log("Thinking disabled.");
      } else {
        console.log("Usage: /thinking <on|off>");
      }
      break;
    }

    case "/incognito": {
      const arg = (parts[1] ?? "").toLowerCase();
      if (!arg) {
        console.log(`Incognito: ${session.isIncognito() ? "ON" : "OFF"}`);
        console.log("Usage: /incognito <on|off>");
        break;
      }
      if (arg === "on") {
        await session.setIncognito(true);
        console.log("Incognito enabled — cross-session memory disabled.");
      } else if (arg === "off") {
        await session.setIncognito(false);
        console.log(
          session.memoryEnabled
            ? "Incognito disabled — cross-session memory enabled."
            : "Incognito disabled — memory remains unavailable (check config.memory.enabled).",
        );
      } else {
        console.log("Usage: /incognito <on|off>");
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
      console.log("State cleared. Starting fresh.");
      break;
    }

    case "/help": {
      printHelp();
      break;
    }

    default:
      console.log(`Unknown command: ${cmd}. Type /help for available commands.`);
  }
}

function printHelp(): void {
  const usage = [
    "  aria                     Start new session in current directory",
    "  aria resume <session>    Resume an existing session",
    "  aria --debug             Start with debug mode enabled",
    "  aria --incognito         Start without cross-session memory persistence",
    "  aria -I                  Short alias for --incognito",
    "  aria --config <path>     Load config from specific .json/.toml path",
    "  aria --help              Show this help",
  ].join("\n");
  const commands = [
    "  /exit                    End session and save",
    "  /state                   List all state objects for this session",
    "  /stats                   Show session, working-memory, and persistent-memory stats",
    "  /digest                  Print cross-session memory digest",
    "  /events                  Show last 20 events",
    "  /recall <query>          Search cross-session knowledge base",
    "  /model <name>            Switch LLM model (e.g., openai/gpt-4o)",
    "  /sessions                List recent sessions",
    "  /debug                   Toggle debug mode (tool blocks + saved prompts)",
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
    chalk.bold("  ARIA — Agent with Retrieval, Intent, and Action") +
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

function currentModelOrDefault(session: Session): string {
  return session.getModelOverride() ?? session.config.llm.model;
}

function readAppVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf-8")) as { version?: string };
    return pkg.version ? `v${pkg.version}` : "v0.0.0";
  } catch {
    return "v0.0.0";
  }
}

function printSessionBanner(session: Session, cwd: string, model: string): void {
  const memoryStats = session.getMemoryStats();
  const digestLen = session.digest?.length ?? 0;
  const configSources = getLoadedConfigSources();
  const lines = [
    `ARIA ${APP_VERSION}`,
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
  console.log(
    boxen(lines.join("\n"), {
      padding: 1,
      borderStyle: "round",
      borderColor: "cyan",
      title: "ARIA",
      titleAlignment: "left",
    })
  );
}

function printSessionEndSummary(session: Session): void {
  const summary = session.getSessionSummary();
  console.log(
    `Session ended: ${summary.turns} turns, ${summary.stateObjects} state objects, ${summary.memoriesStored} memories stored`
  );
}

const isDirectRun = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
