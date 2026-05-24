import {
  Container,
  Input,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
} from "@earendil-works/pi-tui";
import type { Session } from "../session.js";
import { runTurn } from "../turn.js";
import { setUiWriters } from "../ui.js";

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function wrapLine(text: string, width: number): string[] {
  if (width <= 8) return [text];
  const out: string[] = [];
  const words = text.split(/\s+/);
  let cur = "";
  for (const w of words) {
    if (!w) continue;
    if (!cur) {
      cur = w;
      continue;
    }
    if ((cur + " " + w).length <= width) {
      cur += " " + w;
    } else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

export async function runLiveTuiSession(
  session: Session,
  cwd: string,
  initialModel: string,
  options?: {
    showThinking?: boolean;
  }
): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, false);
  const root = new Container();
  const header = new Text("", 0, 0);
  const log = new Text("", 0, 0);
  const hint = new Text("", 0, 0);
  const input = new Input();

  const entries: string[] = [];
  let currentModel = initialModel;
  let busy = false;
  let closed = false;
  let streamingEntry = -1;
  let thinkingEntry = -1;
  let agentBuffer = "";
  let thinkingBuffer = "";
  let pendingTools: string[] = [];
  let showThinking = options?.showThinking ?? true;

  function updateHeader(): void {
    const stats = session.getMemoryStats();
    const digestLen = session.digest?.length ?? 0;
    header.setText(
      [
        "ARIA Live TUI",
        `session=${session.id}  model=${currentModel}`,
        `cwd=${cwd}`,
        `state=${stats.active}/${stats.total}  digest=${digestLen}c`,
      ].join("\n")
    );
  }

  function renderLog(): void {
    const width = Math.max(30, (terminal.columns ?? 100) - 2);
    const wrapped: string[] = [];
    for (const e of entries) {
      wrapped.push(...wrapLine(e, width));
    }
    if (wrapped.length > 180) {
      wrapped.splice(0, wrapped.length - 180);
    }
    log.setText(wrapped.join("\n"));
    tui.requestRender();
  }

  function pushLine(line: string): void {
    entries.push(line);
    if (entries.length > 120) entries.splice(0, entries.length - 120);
    renderLog();
  }

  function updateHint(text: string): void {
    hint.setText(text);
    tui.requestRender();
  }

  function flushPendingTools(): void {
    if (!pendingTools.length) return;
    pushLine(`tools: ${pendingTools.join(" | ")}`);
    pendingTools = [];
  }

  function startStreamingEntry(prefix: string): void {
    entries.push(prefix);
    streamingEntry = entries.length - 1;
    agentBuffer = "";
    renderLog();
  }

  function applyStreamDelta(prev: string, delta: string): string {
    // Some providers emit full-content snapshots instead of true deltas.
    if (delta.startsWith(prev)) return delta;
    return prev + delta;
  }

  function appendTextDelta(delta: string): void {
    if (streamingEntry < 0 || streamingEntry >= entries.length) {
      startStreamingEntry("ARIA: ");
    }
    agentBuffer = applyStreamDelta(agentBuffer, delta);
    entries[streamingEntry] = `ARIA: ${agentBuffer}`;
    renderLog();
  }

  function appendThinkingDelta(delta: string): void {
    if (!showThinking) return;
    if (thinkingEntry < 0 || thinkingEntry >= entries.length) {
      entries.push("thinking: ");
      thinkingEntry = entries.length - 1;
      thinkingBuffer = "";
    }
    thinkingBuffer = applyStreamDelta(thinkingBuffer, delta);
    entries[thinkingEntry] = `thinking: ${thinkingBuffer}`;
    renderLog();
  }

  async function shutdown(reason: "clean" | "aborted"): Promise<void> {
    if (closed) return;
    closed = true;
    setUiWriters();
    try {
      const events = session.getTranscriptEvents();
      await session.end(reason, events);
    } finally {
      tui.stop();
    }
  }

  async function handleCommand(cmdLine: string): Promise<boolean> {
    const parts = cmdLine.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    if (cmd === "/exit" || cmd === "/quit") {
      await shutdown("clean");
      return true;
    }
    if (cmd === "/help") {
      pushLine("system: /help /exit /quit /model <name> /state /stats /thinking on|off");
      return false;
    }
    if (cmd === "/thinking") {
      const arg = (parts[1] ?? "").toLowerCase();
      if (!arg) {
        pushLine(`system: thinking is ${showThinking ? "on" : "off"}`);
      } else if (arg === "on") {
        showThinking = true;
        pushLine("system: thinking enabled");
      } else if (arg === "off") {
        showThinking = false;
        pushLine("system: thinking disabled");
      } else {
        pushLine("system: usage /thinking on|off");
      }
      return false;
    }
    if (cmd === "/model") {
      const next = parts.slice(1).join(" ").trim();
      if (!next) {
        pushLine(`system: current model = ${currentModel}`);
      } else {
        currentModel = next;
        session.setModelOverride(next);
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: { type: "model_override", model: next },
        });
        updateHeader();
        pushLine(`system: model switched to ${next}`);
      }
      return false;
    }
    if (cmd === "/state") {
      flushPendingTools();
      const objects = session.stateGraph.list();
      if (!objects.length) pushLine("system: no state objects");
      else {
        pushLine(`system: state objects (${objects.length})`);
        for (const o of objects.slice(-12)) {
          pushLine(`  - ${o.id} [${o.kind}] ${o.tier} ${o.summary}`);
        }
      }
      return false;
    }
    if (cmd === "/stats") {
      flushPendingTools();
      const stats = session.getMemoryStats();
      pushLine(
        `system: stats total=${stats.total} active=${stats.active} soft=${stats.soft} hard=${stats.hard}`
      );
      return false;
    }
    pushLine(`system: unknown command ${cmd}. try /help`);
    return false;
  }

  setUiWriters({
    stderr: (line) => {
      const cleaned = oneLine(stripAnsi(line));
      if (!cleaned) return;
      if (cleaned.startsWith("[tool]")) {
        pendingTools.push(cleaned.replace("[tool]", "").trim());
        return;
      }
      if (cleaned.startsWith("[state]")) {
        flushPendingTools();
        pushLine(`state: ${cleaned.replace("[state]", "").trim()}`);
        return;
      }
      flushPendingTools();
      pushLine(`meta: ${cleaned}`);
    },
    breakStdout: () => {},
  });

  updateHeader();
  updateHint("Enter to send, /help for commands, /exit to quit");

  input.onSubmit = async (value: string) => {
    const text = value.trim();
    input.setValue("");
    if (!text || busy || closed) return;
    busy = true;
    updateHint("Processing...");
    flushPendingTools();
    pushLine(`you: ${text}`);

    try {
      if (text.startsWith("/")) {
        const shouldClose = await handleCommand(text);
        if (shouldClose) return;
      } else {
        startStreamingEntry("ARIA: ");
        await runTurn(session, text, currentModel, {
          onTextDelta: appendTextDelta,
          onThinkingDelta: appendThinkingDelta,
        });
        streamingEntry = -1;
        thinkingEntry = -1;
        flushPendingTools();
        updateHeader();
      }
    } catch (err: any) {
      flushPendingTools();
      pushLine(`error: ${err?.message ?? "unknown error"}`);
      streamingEntry = -1;
      thinkingEntry = -1;
    } finally {
      busy = false;
      updateHint("Enter to send, /help for commands, /exit to quit");
    }
  };

  root.addChild(header);
  root.addChild(new Spacer(1));
  root.addChild(log);
  root.addChild(new Spacer(1));
  root.addChild(hint);
  root.addChild(input);
  tui.addChild(root);
  tui.setFocus(input);
  tui.start();

  await new Promise<void>((resolve) => {
    const sigint = async () => {
      await shutdown("aborted");
      resolve();
    };
    process.once("SIGINT", sigint);
    const poll = setInterval(() => {
      if (closed) {
        clearInterval(poll);
        process.removeListener("SIGINT", sigint);
        resolve();
      }
    }, 100);
  });
}
