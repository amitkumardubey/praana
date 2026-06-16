import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getMissingKeyMessage, listAvailableProviders, listKnownProviders } from "./llm.js";
import { loadConfig } from "./config.js";
import { getAppLogger, initAppLogFile } from "./logger.js";
import {
  parseCliArgs,
  resolveUiMode,
  resolveScreenMode,
} from "./cli-args.js";
import { printHelp } from "./app-banner.js";
import { AppController } from "./app-controller.js";
import { runReadlineUi } from "./ui/readline-ui.js";
import { runTui } from "./ui/tui/run.js";

export async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.showHelp) {
    printHelp();
    process.exit(0);
  }

  await initAppLogFile();

  const cwd = resolve(process.cwd());
  const config = loadConfig(parsed.configPath);

  // ── Provider validation ────────────────────────────────────
  const keyError = getMissingKeyMessage(config.llm.provider);
  if (keyError) {
    const isInteractive = !!(process.stdin.isTTY && process.stdout.isTTY);
    const detected = listAvailableProviders();

    if (isInteractive) {
      // Interactive: show what was tried and what keys exist
      console.error("");
      console.error("PRAANA needs a model provider to run — no API key found for the selected provider.");
      console.error("");
      if (detected.length > 0) {
        console.error(`Available providers detected in environment: ${detected.join(", ")}`);
        console.error("");
        console.error(`Try switching provider:  /model ${detected[0]} <model-id>`);
      } else {
        console.error("Fastest options:");
        console.error("  • Set a provider key, e.g.  export OPENROUTER_API_KEY=sk-or-...");
        console.error("    (also: OPENAI, ANTHROPIC, DEEPSEEK, GROQ, XAI, FIREWORKS, TOGETHER)");
        console.error("  • Or run:  praana init");
      }
      console.error("");
    } else {
      // Non-interactive: clean scannable message, no traceback
      console.error("PRAANA needs a model provider to run — no API key found.");
      console.error("");
      console.error("Fastest options:");
      console.error("  • Set a provider key, e.g.  export OPENROUTER_API_KEY=sk-or-...");
      console.error("    (also: OPENAI, ANTHROPIC, DEEPSEEK, GROQ, XAI, FIREWORKS, TOGETHER)");
      console.error("  • Or run:  praana init");
      console.error("");
    }

    getAppLogger().error(keyError, { code: "SESSION_START_FAILED" });
    process.exit(1);
  }

  const isInteractive = !!(process.stdin.isTTY && process.stdout.isTTY);
  const uiMode = resolveUiMode(config.ui.mode, parsed.uiMode, isInteractive);
  const screenMode = resolveScreenMode(config.ui.screen, parsed.screenMode);

  const controller = new AppController({ cwd, config, parsed });

  try {
    const info = await controller.start({ uiMode });

    if (uiMode === "tui") {
      await runTui(controller, info, screenMode);
    } else {
      await runReadlineUi(controller, info);
    }
  } catch (err) {
    getAppLogger().error("Failed to start session", {
      code: "SESSION_START_FAILED",
      cause: err as Error,
    });
    process.exit(1);
  }
}

const isDirectRun = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main().catch((err) => {
    getAppLogger().error("Fatal error", { cause: err as Error });
    process.exit(1);
  });
}
