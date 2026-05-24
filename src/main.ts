import * as readline from "node:readline";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Session } from "./session.js";
import { runTurn } from "./turn.js";
import { getMissingKeyMessage } from "./llm.js";
import { loadConfig } from "./config.js";
import type { LlmConfig } from "./types.js";

const APP_VERSION = readAppVersion();

async function main() {
  const args = process.argv.slice(2);

  // Parse args
  let sessionId: string | null = null;
  let resumeMode = false;
  let debug = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    }
    if (args[i] === "--debug" || args[i] === "-d") {
      debug = true;
      continue;
    }
    if (args[i] === "resume" && args[i + 1]) {
      resumeMode = true;
      sessionId = args[i + 1];
      i++;
    }
  }

  const cwd = resolve(process.cwd());
  const config = loadConfig();
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
      session = await Session.create(cwd, config);
      session.debug = debug;
      console.log(`New session: ${session.id}`);
    }
  } catch (err) {
    console.error("Failed to start session:", (err as Error).message);
    process.exit(1);
  }

  let showThinking = true;

  await printSessionBanner(session, cwd, currentModelOrDefault(session));
  console.log('Type /help for commands, /exit to quit.');
  console.log();

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  let currentModel: string | undefined = session.getModelOverride() ?? undefined;

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
      rl.prompt();
      return;
    }

    // Regular turn
    try {
      let thinkingOpen = false;
      await runTurn(session, input, currentModel, {
        onThinkingDelta: (delta) => {
          if (!showThinking) return;
          if (!thinkingOpen) {
            process.stdout.write("\n\x1b[2m[thinking] ");
            thinkingOpen = true;
          }
          process.stdout.write(delta);
        },
      });
      if (thinkingOpen) {
        process.stdout.write("\x1b[0m\n");
      }
    } catch (err) {
      console.error("\n[error]", (err as Error).message);
      session.eventLog.append({
        kind: "system_note",
        actor: "kernel",
        payload: { type: "error", message: (err as Error).message },
      });
    }

    console.log();
    rl.prompt();
  });

  rl.on("close", async () => {
    if (!sessionEnded) {
      sessionEnded = true;
      console.log("\nShutting down...");
      const events = session.getTranscriptEvents();
      await session.end("clean", events);
      printSessionEndSummary(session);
    }
    process.exit(0);
  });

  // Handle Ctrl+C
  process.on("SIGINT", () => {
    console.log("\nUse /exit to save and quit.");
    rl.prompt();
  });
}

async function handleSlashCommand(
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
      const events = session.getTranscriptEvents();
      await session.end("clean", events);
      printSessionEndSummary(session);
      rl.close();
      return;
    }

    case "/state": {
      const objects = session.stateGraph.list();
      if (objects.length === 0) {
        console.log("No state objects.");
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
      console.log("\nMemory stats:");
      console.log(`  Total: ${stats.total}`);
      console.log(`  Active: ${stats.active}`);
      console.log(`  Soft: ${stats.soft}`);
      console.log(`  Hard: ${stats.hard}`);
      const kindParts = Object.entries(stats.byKind)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, count]) => `${kind}:${count}`);
      console.log(`  By kind: ${kindParts.length ? kindParts.join(", ") : "(none)"}`);

      if (session.memoryEnabled) {
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
              `  - [${e.kind}] ${e.content.slice(0, 100)} (conf: ${e.confidence.toFixed(2)})`
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
        const eventsPath = join(logDir, d.name, "events.log");
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

    case "/help": {
      printHelp();
      break;
    }

    default:
      console.log(`Unknown command: ${cmd}. Type /help for available commands.`);
  }
}

function printHelp(): void {
  console.log(`
ARIA — Agent with Retrieval, Intent, and Action

USAGE:
  aria                     Start new session in current directory
  aria resume <session_id> Resume an existing session
  aria --help              Show this help


SLASH COMMANDS:
  /exit                    End session and save
  /state                   List all state objects
  /stats                   Show memory tier counts and kind distribution
  /digest                  Print cross-session memory digest
  /events                  Show last 20 events
  /recall <query>          Search cross-session knowledge base
  /model <name>            Switch LLM model (e.g., /model openai/gpt-4o)
  /sessions                List recent sessions (resume with npx tsx src/main.ts resume <id>)
  /debug                   Toggle debug mode (detailed tool blocks + saved prompts)
  /thinking <on|off>       Toggle thinking stream visibility
  /help                    Show this help
`);
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
  const content = [
    `ARIA ${APP_VERSION}`,
    `session: ${session.id}`,
    `cwd: ${cwd}`,
    `model: ${model}`,
    `memory entries: ${memoryStats.total}`,
    `digest chars: ${digestLen}`,
    session.memoryEnabled
      ? `memory db: ${session.getMemoryDbPath() ?? "(unknown)"}`
      : "memory: disabled",
  ];
  const width = Math.max(...content.map((s) => s.length));
  console.log(`┌${'─'.repeat(width + 2)}┐`);
  for (const line of content) {
    console.log(`│ ${line.padEnd(width)} │`);
  }
  console.log(`└${'─'.repeat(width + 2)}┘`);
}

function printSessionEndSummary(session: Session): void {
  const summary = session.getSessionSummary();
  console.log(
    `Session ended: ${summary.turns} turns, ${summary.stateObjects} state objects, ${summary.memoriesStored} memories stored`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
