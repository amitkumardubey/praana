import * as readline from "node:readline";
import chalk from "chalk";
import type { AppController, StartupInfo } from "../app-controller.js";
import { TurnAbortedError, EscInterruptListener } from "../turn-control.js";
import { formatEmojiStatusLine } from "../status-bar.js";
import { printSessionBanner, printSessionEndSummary } from "../app-banner.js";
import { createDefaultTurnSink } from "../ui-events.js";
import {
  createThinkingState,
  onThinkingDelta,
  closeThinking as closeThinkingBlock,
  toggleThinking,
} from "../thinking-display.js";
import { startSpinner, stopSpinner } from "../ui.js";
import { writeMarkdown } from "../render.js";

export async function runReadlineUi(
  controller: AppController,
  info: StartupInfo
): Promise<void> {
  const { session, cwd, model, isResume } = info;

  printSessionBanner(session, cwd, model);

  if (isResume) {
    if (info.recentConversationLines.length > 0) {
      console.log("\n" + info.recentConversationLines.join("\n") + "\n");
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "◆ ",
  });

  const refreshStatusBar = () => {
    const line = formatEmojiStatusLine(controller.getStatusBarInput());
    if (process.stderr.isTTY) {
      process.stderr.write(line + "\n");
    } else {
      console.log(line);
    }
  };

  refreshStatusBar();
  console.log();
  rl.prompt();

  const escListener = new EscInterruptListener();

  const handleUserInterrupt = (): void => {
    controller.handleUserInterrupt(() => {
      console.log("\nUse /exit to save and quit.");
      rl.prompt();
    });
  };

  process.on("SIGINT", handleUserInterrupt);

  rl.on("line", async (line: string) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith("/")) {
      const result = await controller.executeSlashCommand(input);
      for (const l of result.lines) {
        if (l) console.log(l);
      }
      if (result.action === "refresh_status") refreshStatusBar();
      if (result.action === "exit") {
        rl.close();
        return;
      }
      rl.prompt();
      return;
    }

    startSpinner("thinking…");
    let spinnerStopped = false;
    const stopSpinnerOnce = () => {
      if (spinnerStopped) return;
      stopSpinner();
      spinnerStopped = true;
    };

    const thinking = createThinkingState(controller.showThinking);
    const closeThinking = () => {
      const summary = closeThinkingBlock(thinking);
      if (summary) {
        process.stdout.write(chalk.dim(`\n${summary}\n`));
      } else {
        process.stdout.write("\n");
      }
    };

    const onKeypress = (_: string, key: { name?: string }) => {
      if (key?.name === "t") {
        const nowVisible = toggleThinking(thinking);
        process.stdout.write(
          chalk.dim(nowVisible ? "\n[thinking on]" : "\n[thinking off]")
        );
        refreshStatusBar();
      }
    };

    const markdownRendering = controller.config.ui.markdown_rendering;
    const syntaxTheme = controller.config.ui.syntax_theme;
    let textBuffer = "";
    const flushMarkdown = () => {
      if (textBuffer) {
        if (markdownRendering) {
          // Strip trailing \n before rendering — marked adds its own paragraph breaks.
          // Leaving it causes double newlines when successive deltas flush at \n boundaries.
          const text = textBuffer.replace(/\n$/, "");
          if (text) writeMarkdown(text, process.stdout);
        } else {
          process.stdout.write(textBuffer);
        }
        textBuffer = "";
      }
    };

    const sink = createDefaultTurnSink({
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
        if (!markdownRendering) {
          process.stdout.write(delta);
          return;
        }
        textBuffer += delta;
        const lastNewline = textBuffer.lastIndexOf("\n");
        if (lastNewline >= 0) {
          const toFlush = textBuffer.slice(0, lastNewline);
          textBuffer = textBuffer.slice(lastNewline + 1);
          if (toFlush) writeMarkdown(toFlush, process.stdout);
        }
      },
      onToolCallsStart: () => {
        flushMarkdown();
        closeThinking();
      },
    });
    sink.flushText = flushMarkdown;

    process.stdin.on("keypress", onKeypress);
    escListener.start(() => controller.abortTurn(), rl);

    try {
      await controller.runUserTurn(input, sink);
      flushMarkdown();
      closeThinking();
      stopSpinnerOnce();
    } catch (err) {
      stopSpinnerOnce();
      closeThinking();
      if (err instanceof TurnAbortedError) {
        console.log(chalk.yellow("\n[interrupted]"));
      } else {
        session.getLogger().error("Turn failed", {
          code: "TURN_FAILED",
          cause: err as Error,
        });
      }
    } finally {
      process.stdin.removeListener("keypress", onKeypress);
      escListener.stop();
    }

    console.log();
    refreshStatusBar();
    rl.prompt();
  });

  rl.on("close", async () => {
    console.log("\nShutting down...");
    await controller.shutdown();
    printSessionEndSummary(session);
    process.exit(0);
  });

  rl.on("SIGINT", handleUserInterrupt);
}
