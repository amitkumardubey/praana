import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getMissingKeyMessage, getProviderEnvKey } from "./llm.js";
import { loadConfig, getConfigWarnings } from "./config.js";
import { getAppLogger, initAppLogFile } from "./logger.js";
import { parseCliArgs } from "./cli-args.js";
import { printHelp, APP_VERSION } from "./app-banner.js";
import { AppController } from "./app-controller.js";
import { SessionNotFoundError } from "./session.js";
import { runTui } from "./ui/tui/run.js";
import { runInteractiveSetup } from "./interactive-setup.js";
import { runMemoryDedupe } from "./memory-dedupe-cli.js";
import { isFirstRun, markInitialized, APP_NAME } from "./app-identity.js";
import { formatProviderListForDisplay, PROVIDER_REGISTRY } from "./provider-registry.js";
import { handleDoctor } from "./doctor.js";
import { isInteractiveTerminal } from "./terminal.js";

export async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.showHelp) {
    printHelp();
    process.exit(0);
  }

  if (parsed.versionMode) {
    console.log(`${APP_NAME} ${APP_VERSION}`);
    process.exit(0);
  }

  if (parsed.providersMode) {
    if (parsed.allMode) {
      const all = formatProviderListForDisplay();
      const registrySet = new Set(Object.keys(PROVIDER_REGISTRY));
      const extra = all.filter((e) => !registrySet.has(e.name));
      console.log("Supported providers:");
      for (const { name } of all.filter((e) => registrySet.has(e.name))) {
        console.log(`  ${name}`);
      }
      if (extra.length > 0) {
        console.log("");
        console.log("Additional providers via pi-ai (experimental, no PRAANA defaults):");
        for (const { name } of extra) console.log(`  ${name}`);
      }
    } else {
      const names = Object.keys(PROVIDER_REGISTRY).sort();
      console.log("Supported providers:");
      for (const name of names) console.log(`  ${name}`);
      const piOnlyCount = formatProviderListForDisplay().filter(
        (e) => !Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, e.name),
      ).length;
      if (piOnlyCount > 0) {
        console.log(`\n  (${piOnlyCount} more via pi-ai — run with --all to see them)`);
      }
    }
    process.exit(0);
  }

  await initAppLogFile();

  // Handle setup command early (before config loading, needs a TTY)
  if (parsed.setupMode) {
    if (!isInteractiveTerminal()) {
      console.error("praana setup requires an interactive terminal.");
      process.exit(1);
    }
    const cwd = resolve(process.cwd());
    const result = await runInteractiveSetup(cwd);
    process.exit(result.success ? 0 : 1);
  }

  const cwd = resolve(process.cwd());
  const config = loadConfig(parsed.configPath);

  // Handle doctor command (after config loading)
  if (parsed.doctorMode) {
    const result = await handleDoctor(config);
    for (const line of result.lines) console.log(line);
    process.exit(result.success ? 0 : 1);
  }

  const warnings = getConfigWarnings();
  if (warnings.length > 0) {
    console.error("");
    console.error("Configuration warnings:");
    for (const w of warnings) console.error(`  ⚠ ${w}`);
    console.error("");
  }

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

  const isInteractive = isInteractiveTerminal();

  // ── Provider validation ────────────────────────────────────
  const keyError = getMissingKeyMessage(config.llm.provider);
  if (keyError) {
    if (isInteractive) {
      const setupResult = await runInteractiveSetup(cwd);
      if (!setupResult.success) {
        getAppLogger().error("Provider setup cancelled", { code: "SESSION_START_FAILED" });
        console.error("");
        console.error("You can also run:  praana init");
        console.error("This creates a config template you can edit manually.");
        process.exit(1);
      }
      const newConfig = loadConfig(parsed.configPath);
      const newWarnings = getConfigWarnings();
      if (newWarnings.length > 0) {
        console.error("");
        console.error("Configuration warnings:");
        for (const w of newWarnings) console.error(`  ⚠ ${w}`);
        console.error("");
      }
      const newKeyError = getMissingKeyMessage(newConfig.llm.provider);
      if (newKeyError) {
        const envKey = getProviderEnvKey(newConfig.llm.provider);
        console.error("");
        if (envKey) {
          console.error("Almost there! To finish setup:");
          console.error(`  1. Set your key:  export ${envKey}=<your-key>`);
          console.error("  2. Restart:       praana");
        } else {
          console.error("Almost there! To finish setup, configure the provider and restart PRAANA.");
        }
        console.error("");
        getAppLogger().error(newKeyError, { code: "SESSION_START_FAILED" });
        process.exit(1);
      }
      Object.assign(config, newConfig);
    } else {
      const envKeyNames = Array.from(
        new Set(
          formatProviderListForDisplay()
            .filter((p) => p.envKey !== null)
            .map((p) => p.envKey as string),
        ),
      );
      console.error("PRAANA needs a model provider to run — no API key found.");
      console.error("");
      console.error("Fastest options:");
      console.error("  • Set a provider key, e.g.  export OPENROUTER_API_KEY=sk-or-...");
      console.error(`    (also: ${envKeyNames.join(", ")})`);
      console.error("  • Or run:  praana init");
      console.error("");
      getAppLogger().error(keyError, { code: "SESSION_START_FAILED" });
      process.exit(1);
    }
  }

  // ── Empty-model guard ─────────────────────────────────────
  if (!config.llm.model || !config.llm.model.trim()) {
    getAppLogger().error("No LLM model configured", {
      code: "SESSION_START_FAILED",
    });
    console.error("");
    console.error("No model is configured for provider:", config.llm.provider);
    console.error('Set [llm] model = "..." in your config or run `praana init`.');
    console.error("");
    process.exit(1);
  }

  // ── First-run welcome ──────────────────────────────────────
  if (isFirstRun()) {
    markInitialized();
    if (isInteractive) {
      console.log("");
      console.log("  Created ~/.praana/ for config, sessions, and memory.");
      console.log("  Welcome to PRAANA! This is your first session.");
      console.log("  Memory and embedding models will be set up automatically.");
      console.log("  Run /help anytime, or praana doctor to check your setup.");
      console.log("  Tip: Add personal instructions to ~/.praana/AGENTS.md");
      console.log("");
    }
  }

  // ── TTY guard ──────────────────────────────────────────────
  if (!isInteractive) {
    getAppLogger().error("Session start requires an interactive terminal", {
      code: "SESSION_START_FAILED",
    });
    console.error("");
    console.error("PRAANA requires an interactive terminal to start a session.");
    console.error("Run `praana --help` for non-interactive commands.");
    console.error("");
    process.exit(1);
  }

  const controller = new AppController({ cwd, config, parsed });

  try {
    const info = await controller.start();
    await runTui(controller, info);
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      console.error(`Session not found: ${err.sessionId}`);
      console.error("");
      console.error("List available sessions with:  praana");
      console.error("Then resume with:  praana resume <session-id>");
    } else {
      const msg = (err as Error).message;
      getAppLogger().error("Failed to start session", {
        code: "SESSION_START_FAILED",
        cause: err as Error,
      });
      console.error(`Failed to start session: ${msg}`);
    }
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
