import type { UiScreenMode } from "../../types.js";
import type { AppController, StartupInfo } from "../../app-controller.js";
import {
  formatSessionEndSummary,
  formatSessionEpilogue,
} from "../../app-banner.js";
import { formatTuiBootSummary } from "./formatters.js";
import { estimateTokens } from "../../token-estimate.js";
import {
  createInitialTranscriptState,
  transcriptReducer,
  type TranscriptAction,
  type TranscriptEntry,
  type TranscriptState,
} from "./reducer.js";
import { createChatSink } from "./sink.js";
import { TurnAbortedError } from "../../turn-control.js";
import type { TurnUiSink } from "../../ui-events.js";
import { createAlternateTerminal } from "../../terminal/backend/alternate.js";
import { runProgram, type Program } from "../../terminal/runtime/program.js";
import { none, quit, task } from "../../terminal/runtime/cmd.js";
import { view } from "../../terminal/runtime/view.js";
import { attachKeyListener } from "../../terminal/backend/stdin-keys.js";
import type { KeyMsg } from "../../terminal/runtime/msg.js";
import { drawChatView } from "./view.js";
import type { StatusBarInput } from "../../status-bar.js";
import {
  createAppendBackendState,
  createAppendBackend,
} from "../../terminal/backend/append.js";
import { renderTranscriptLines } from "./render-lines.js";
import { formatStatusLine } from "../../status-bar.js";
import * as readline from "node:readline";

export async function runChatShell(
  controller: AppController,
  info: StartupInfo,
  screen: UiScreenMode
): Promise<void> {
  if (screen === "alternate") {
    await runAlternateShell(controller, info);
  } else {
    await runPreserveShell(controller, info);
  }
}

// ── Alternate screen (buffer diff program) ─────────────────

interface ShellModel {
  transcript: TranscriptState;
  input: string;
  status: StatusBarInput;
  showThinking: boolean;
  toast: string | null;
  bootSummary: string;
  showLogo: boolean;
  markdownRendering: boolean;
  exiting: boolean;
}

type ShellMsg =
  | TranscriptAction
  | KeyMsg
  | { type: "set_input"; value: string }
  | { type: "submit" }
  | { type: "refresh_status" }
  | { type: "toast"; message: string }
  | { type: "exit" };

async function runAlternateShell(
  controller: AppController,
  info: StartupInfo
): Promise<void> {
  const config = controller.config;
  const session = controller.session;
  const bootSummary = formatTuiBootSummary({
    sessionId: session.id,
    contextTokens: session.agentsContext
      ? estimateTokens(session.agentsContext)
      : undefined,
    engineEnabled: session.isContextEngineEnabled(),
    skillCount: session.skills.length,
    memoryEnabled: session.memoryEnabled,
    incognito: session.isIncognito(),
  });

  let transcript = createInitialTranscriptState();
  if (info.transcriptBootstrap.length > 0) {
    transcript = transcriptReducer(transcript, {
      type: "bootstrap",
      entries: info.transcriptBootstrap,
    });
  }

  let sink: TurnUiSink | null = null;
  let sendRef: ((msg: ShellMsg) => void) | null = null;

  const program: Program<ShellModel, ShellMsg> = {
    init() {
      return [
        {
          transcript,
          input: "",
          status: controller.getStatusBarInput(),
          showThinking: controller.showThinking,
          toast: null,
          bootSummary,
          showLogo: info.transcriptBootstrap.length === 0,
          markdownRendering: config.ui.markdown_rendering,
          exiting: false,
        },
        none(),
      ];
    },
    update(model, msg) {
      if (msg.type === "key") {
        if (model.transcript.busy && msg.key.escape) {
          controller.abortTurn();
          return [model, none()];
        }
        if (msg.key.ctrl && msg.input === "t" && !model.transcript.busy) {
          controller.showThinking = !controller.showThinking;
          return [
            {
              ...model,
              showThinking: controller.showThinking,
              toast: controller.showThinking ? "Thinking enabled." : "Thinking disabled.",
            },
            none(),
          ];
        }
        if (msg.key.ctrl && msg.key.name === "c") {
          controller.handleUserInterrupt(() => {
            sendRef?.({ type: "toast", message: "Use /exit to save and quit." });
          });
          return [model, none()];
        }
        if (msg.key.return) {
          return [{ ...model }, task((send) => send({ type: "submit" }))];
        }
        if (msg.key.backspace) {
          return [{ ...model, input: model.input.slice(0, -1) }, none()];
        }
        if (msg.input && !msg.key.ctrl && !msg.key.meta) {
          return [{ ...model, input: model.input + msg.input }, none()];
        }
        return [model, none()];
      }

      if (msg.type === "set_input") {
        return [{ ...model, input: msg.value }, none()];
      }

      if (msg.type === "refresh_status") {
        return [{ ...model, status: controller.getStatusBarInput() }, none()];
      }

      if (msg.type === "toast") {
        return [{ ...model, toast: msg.message }, none()];
      }

      if (msg.type === "exit") {
        return [{ ...model, exiting: true }, quit()];
      }

      if (msg.type === "submit") {
        const trimmed = model.input.trim();
        if (!trimmed) return [model, none()];
        if (model.transcript.busy) {
          return [
            {
              ...model,
              toast: "Cannot process commands while a turn is active. Press Esc to interrupt.",
            },
            none(),
          ];
        }

        if (trimmed.startsWith("/")) {
          return [
            { ...model, input: "" },
            task(async (send) => {
              const result = await controller.executeSlashCommand(trimmed);
              if (result.lines.length > 0) {
                if (result.display === "toast") {
                  send({ type: "toast", message: result.lines.join(" ") });
                } else {
                  send({ type: "system_lines", lines: result.lines });
                }
              }
              if (result.action === "clear_transcript") {
                send({ type: "clear_transcript" });
              }
              if (result.action === "refresh_status") {
                send({ type: "refresh_status" });
              }
              if (result.action === "exit") {
                send({ type: "exit" });
              }
            }),
          ];
        }

        const turnStartedAt = Date.now();
        return [
          {
            ...model,
            input: "",
            transcript: transcriptReducer(
              transcriptReducer(model.transcript, { type: "user_message", text: trimmed }),
              { type: "set_busy", busy: true }
            ),
            showLogo: false,
          },
          task(async (send) => {
            const dispatch = (action: TranscriptAction) => send(action);
            const localSink = createChatSink(dispatch);
            sink = localSink;
            try {
              await controller.runUserTurn(trimmed, localSink);
              localSink.flushText?.();
              send({ type: "assistant_complete" });
              const bar = controller.getStatusBarInput();
              send({
                type: "turn_footer",
                model: bar.model,
                durationMs: Date.now() - turnStartedAt,
                stats: localSink.consumeTurnStats?.() ?? undefined,
              });
            } catch (err) {
              if (err instanceof TurnAbortedError) {
                send({ type: "toast", message: "Turn interrupted" });
                const bar = controller.getStatusBarInput();
                send({
                  type: "turn_footer",
                  model: bar.model,
                  durationMs: Date.now() - turnStartedAt,
                  stats: localSink.consumeTurnStats?.() ?? undefined,
                });
              } else {
                send({
                  type: "error",
                  message: (err as Error).message,
                });
              }
            } finally {
              send({ type: "set_busy", busy: false });
              send({ type: "refresh_status" });
            }
          }),
        ];
      }

      // Transcript actions
      if ("type" in msg && isTranscriptAction(msg)) {
        const next = transcriptReducer(model.transcript, msg);
        return [{ ...model, transcript: next, toast: null }, none()];
      }

      return [model, none()];
    },
    view(model) {
      return view(
        (frame) => {
          drawChatView(frame, model.transcript, {
            showThinking: model.showThinking,
            markdownRendering: model.markdownRendering,
            bootSummary: model.bootSummary,
            showLogo: model.showLogo,
            status: model.status,
            input: model.input,
            toast: model.toast,
          });
        },
        { alternateScreen: true }
      );
    },
  };

  const terminal = createAlternateTerminal();
  await runProgram(program, terminal, {
    alternateScreen: true,
    onKey: (send) => {
      sendRef = send;
      sink = createChatSink((action) => send(action));
      return attachKeyListener((key) => send(key));
    },
    fps: 20,
  });

  await shutdownShell(controller);
}

function isTranscriptAction(msg: ShellMsg): msg is TranscriptAction {
  const t = (msg as TranscriptAction).type;
  return (
    t === "set_busy" ||
    t === "user_message" ||
    t === "assistant_delta" ||
    t === "assistant_complete" ||
    t === "thinking_delta" ||
    t === "thinking_close" ||
    t === "tool_call" ||
    t === "tool_result" ||
    t === "turn_footer" ||
    t === "system_lines" ||
    t === "clear_transcript" ||
    t === "error" ||
    t === "bootstrap"
  );
}

// ── Preserve screen (append scrollback) ──────────────────────

async function runPreserveShell(
  controller: AppController,
  info: StartupInfo
): Promise<void> {
  const config = controller.config;

  // Backend must exist before bootstrap so printEntry can use it.
  const appendState = createAppendBackendState(process.stdout.columns ?? 80, 2);
  const appendBackend = createAppendBackend(appendState);

  function printEntry(entry: TranscriptEntry): void {
    // appendLines internally erases any rendered live region first (see
    // backend/append.ts), so committed text always sits above the live area.
    const lines = renderTranscriptLines([entry], {
      showThinking: controller.showThinking,
      markdownRendering: config.ui.markdown_rendering,
      ttyOutput: true,
    });
    appendBackend.appendLines(lines.map((l) => l.text));
  }

  let transcript = createInitialTranscriptState();
  // committedCount tracks how many completed entries have been printed.
  // Bootstrap entries are printed directly and pre-counted.
  let committedCount = 0;
  if (info.transcriptBootstrap.length > 0) {
    transcript = transcriptReducer(transcript, {
      type: "bootstrap",
      entries: info.transcriptBootstrap,
    });
    for (const entry of info.transcriptBootstrap) {
      printEntry(entry);
    }
    committedCount = info.transcriptBootstrap.length;
  }

  const dispatch = (action: TranscriptAction): void => {
    transcript = transcriptReducer(transcript, action);

    // Walk the watermark: commit consecutive ready entries.
    // Stop at the first unready entry so a pending tool stub is never printed
    // before its result arrives — tool_result mutates the entry in place and
    // the append backend cannot rewrite already-scrolled lines.
    while (committedCount < transcript.completed.length) {
      const entry = transcript.completed[committedCount]!;
      if (!isEntryReady(entry)) break;
      printEntry(entry);
      committedCount++;
    }

    // For streaming deltas repaint the live region; for everything else clear
    // it (committed entries have already been written to scrollback above).
    if (action.type === "assistant_delta" || action.type === "thinking_delta") {
      const lines = renderTranscriptLines(
        transcript.live ? [transcript.live] : [],
        // No markdown for streaming — partial text renders poorly; colours via ttyOutput
        { showThinking: controller.showThinking, markdownRendering: false, ttyOutput: true }
      );
      appendBackend.setLiveLines(lines.map((l) => l.text));
    } else {
      appendBackend.clearLive();
    }
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "❯ ",
  });

  const printStatus = () => {
    const line = formatStatusLine(controller.getStatusBarInput());
    process.stderr.write(line + "\n");
  };

  printStatus();
  rl.prompt();

  const sink = createChatSink(dispatch);

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    if (trimmed.startsWith("/")) {
      const result = await controller.executeSlashCommand(trimmed);
      if (result.lines.length > 0) {
        for (const l of result.lines) console.log(l);
      }
      if (result.action === "clear_transcript") {
        dispatch({ type: "clear_transcript" });
        committedCount = 0;
      }
      if (result.action === "refresh_status") printStatus();
      if (result.action === "exit") {
        rl.close();
        return;
      }
      rl.prompt();
      return;
    }

    // dispatch is the sole printer — no manual printEntry calls here.
    dispatch({ type: "user_message", text: trimmed });
    dispatch({ type: "set_busy", busy: true });
    const turnStartedAt = Date.now();

    try {
      await controller.runUserTurn(trimmed, sink);
      sink.flushText?.();
      dispatch({ type: "assistant_complete" });
      const bar = controller.getStatusBarInput();
      dispatch({
        type: "turn_footer",
        model: bar.model,
        durationMs: Date.now() - turnStartedAt,
        stats: sink.consumeTurnStats?.() ?? undefined,
      });
    } catch (err) {
      if (err instanceof TurnAbortedError) {
        console.log("\n[interrupted]");
      } else {
        console.error((err as Error).message);
      }
    } finally {
      dispatch({ type: "set_busy", busy: false });
      // Force-drain any stranded entries unconditionally. A tool_call
      // interrupted before tool_result leaves an unready entry that the
      // normal watermark walk skips — if left in place it blocks every
      // subsequent turn's entries forever (the break fires on the very first
      // next user_message). At turn end no result will arrive, so print
      // whatever is there regardless of readiness.
      while (committedCount < transcript.completed.length) {
        printEntry(transcript.completed[committedCount]!);
        committedCount++;
      }
      appendBackend.clearLive();
      printStatus();
      rl.prompt();
    }
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => resolve());
  });

  await shutdownShell(controller);
}

/**
 * A tool entry in the completed list is not ready to print until its result
 * has landed. `tool_result` updates the entry in place (reducer:266-282), so
 * committing the stub early would produce an already-scrolled line the append
 * backend cannot rewrite, leading to duplication or missing result text.
 */
function isEntryReady(entry: TranscriptEntry): boolean {
  return entry.role !== "tool" || entry.resultText !== undefined;
}


async function shutdownShell(controller: AppController): Promise<void> {
  process.stderr.write("\nSaving session…\n");
  const { memory } = await controller.shutdown();
  if (memory === "background") {
    process.stderr.write("Memory save continuing in background…\n");
  }
  for (const line of formatSessionEpilogue(controller.session.id)) {
    console.log(line);
  }
  console.log(formatSessionEndSummary(controller.session));
  process.exit(0);
}
