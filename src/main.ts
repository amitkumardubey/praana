import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getMissingKeyMessage } from "./llm.js";
import { loadConfig } from "./config.js";
import { getAppLogger, initAppLogFile } from "./logger.js";
import { parseCliArgs } from "./cli-args.js";
import { printHelp } from "./app-banner.js";
import { AppController } from "./app-controller.js";
import { runTui } from "./ui/tui/run.js";
import { handleInit } from "./init.js";
import { runInteractiveSetup } from "./interactive-setup.js";
import { runMemoryDedupe } from "./memory-dedupe-cli.js";

export async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.showHelp) {
    printHelp();
    process.exit(0);
  }

  await initAppLogFile();

  // Handle init command early (before config loading)
  if (parsed.initMode) {
    const cwd = resolve(process.cwd());
    const result = handleInit({ force: parsed.force, cwd });
    console.log(result.message);
    process.exit(result.success ? 0 : 1);
  }

  const cwd = resolve(process.cwd());
  const config = loadConfig(parsed.configPath);

  if (parsed.memoryDedupeMode) {
    try {
      await runMemoryDedupe(cwd, config);
      process.exit(0);
    } catch (err) {
      getAppLogger().error("Memory dedupe failed", {
        code: "MEMORY_DEDUPE_FAILED",
        cause: err as Error,
      });
      console.error((err as Error).message);
      process.exit(1);
    }
  }

  const isInteractive = !!(process.stdin.isTTY && process.stdout.isTTY);

  // ── Provider validation ────────────────────────────────────
  const keyError = getMissingKeyMessage(config.llm.provider);
  if (keyError) {
    if (isInteractive) {
      const setupResult = await runInteractiveSetup(cwd);
      if (!setupResult.success) {
        getAppLogger().error("Provider setup cancelled", { code: "SESSION_START_FAILED" });
        process.exit(1);
      }
      const newConfig = loadConfig(parsed.configPath);
      const newKeyError = getMissingKeyMessage(newConfig.llm.provider);
      if (newKeyError) {
        console.error("");
        console.error("Key still not detected. Please set the environment variable and restart.");
        console.error("");
        getAppLogger().error(newKeyError, { code: "SESSION_START_FAILED" });
        process.exit(1);
      }
      Object.assign(config, newConfig);
    } else {
      console.error("PRAANA needs a model provider to run — no API key found.");
      console.error("");
      console.error("Fastest options:");
      console.error("  • Set a provider key, e.g.  export OPENROUTER_API_KEY=sk-or-...");
      console.error("    (also: OPENAI, ANTHROPIC, DEEPSEEK, GROQ, XAI, FIREWORKS, TOGETHER)");
      console.error("  • Or run:  praana init");
      console.error("");
      getAppLogger().error(keyError, { code: "SESSION_START_FAILED" });
      process.exit(1);
    }
  }

  // ── TTY guard ──────────────────────────────────────────────
  if (!isInteractive) {
    process.stderr.write("praana requires an interactive terminal (TTY)\n");
    process.exit(1);
  }

  const controller = new AppController({ cwd, config, parsed });

  try {
    const info = await controller.start();
    await runTui(controller, info);
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
