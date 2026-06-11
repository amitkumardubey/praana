import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getMissingKeyMessage } from "./llm.js";
import { loadConfig } from "./config.js";
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

  const cwd = resolve(process.cwd());
  const config = loadConfig(parsed.configPath);
  const keyError = getMissingKeyMessage(config.llm.provider);
  if (keyError) {
    console.error(keyError);
    process.exit(1);
  }

  const isInteractive = !!(process.stdin.isTTY && process.stdout.isTTY);
  const uiMode = resolveUiMode(config.ui.mode, parsed.uiMode, isInteractive);
  const screenMode = resolveScreenMode(config.ui.screen, parsed.screenMode);

  const controller = new AppController({ cwd, config, parsed });

  try {
    const info = await controller.start();

    if (uiMode === "tui") {
      await runTui(controller, info, screenMode);
    } else {
      await runReadlineUi(controller, info);
    }
  } catch (err) {
    console.error("Failed to start session:", (err as Error).message);
    process.exit(1);
  }
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
