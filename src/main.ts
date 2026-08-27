import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getMissingKeyMessage } from "./llm.js";
import { loadConfig, getConfigWarnings } from "./config.js";
import { getAppLogger, initAppLogFile } from "./logger.js";
import { parseCliArgs } from "./cli-args.js";
import { printHelp, APP_VERSION, formatSessionEndEpilogue } from "./app-banner.js";
import { AppController } from "./app-controller.js";
import { SessionNotFoundError } from "./session.js";
import { AmbiguousSessionPrefixError } from "./session-errors.js";
import { runTui } from "./ui/tui/run.js";
import { runInteractiveSetup } from "./interactive-setup.js";
import { tryAutoSelectProvider } from "./setup/logic.js";
import { writeProviderConfig } from "./setup/config-writer.js";
import { ensureCredentialsFileMode } from "./credentials.js";
import { runMemoryDedupe } from "./memory-dedupe-cli.js";
import { isFirstRun, markInitialized, APP_NAME } from "./app-identity.js";
import { formatProviderListForDisplay } from "./provider-registry.js";
import { handleDoctor } from "./doctor.js";
import { isInteractiveTerminal } from "./terminal.js";
import { needsInteractiveEmbedderConsent } from "./memory/embedder-consent.js";
import {
  formatModelsCliOutput,
  listModelsForCli,
} from "./model-listing.js";
import {
  formatProvidersCliOutput,
  listProvidersForCli,
} from "./providers-cli.js";
import { runHeadless } from "./headless-run.js";

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
    const entries = listProvidersForCli({
      includeUnavailable: parsed.allMode,
    });
    console.log(formatProvidersCliOutput(entries));
    process.exit(entries.length === 0 ? 1 : 0);
  }

  if (parsed.modelsMode) {
    try {
      const config = loadConfig(parsed.configPath);
      const entries = await listModelsForCli(
        parsed.modelsProvider ?? undefined,
        { includeUnavailable: parsed.allMode },
      );
      console.log(
        formatModelsCliOutput(entries, {
          defaultProvider: config.llm.provider || undefined,
          defaultModel: config.llm.model || undefined,
        }),
      );
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  }

  await initAppLogFile();
  ensureCredentialsFileMode();

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
  let needsOnboarding = false;

  // ── Provider validation ────────────────────────────────────
  const keyError = getMissingKeyMessage(config.llm.provider);
  if (keyError) {
    // Power-user fast path: if exactly one known provider has an env key
    // (or a stored key) and no config file exists yet, auto-adopt the env
    // key into the credential store and write a minimal config. Skips the
    // multi-step wizard entirely. Returns null for ambiguous cases (0 or
    // >1 key-requiring providers, user-declared providers, keyless
    // providers). Works in both interactive and non-interactive modes.
    const auto = tryAutoSelectProvider();
    if (auto) {
      const writeResult = writeProviderConfig(auto.provider, {
        model: auto.model,
      });
      if (writeResult.written) {
        console.log(
          auto.adoptedFromEnv
            ? `Adopted ${auto.envKey} from environment — provider: ${auto.provider}, model: ${auto.model}`
            : `Using stored key — provider: ${auto.provider}, model: ${auto.model}`,
        );
        // Reload the file the auto-select just wrote (not a stale --config path).
        Object.assign(config, loadConfig(writeResult.path));
      }
    }

    // Re-check after auto-select — may now be fully configured.
    const stillMissing = getMissingKeyMessage(config.llm.provider);
    if (stillMissing) {
      const printMissingProvider = () => {
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
        console.error("  • Run:  praana setup  (guided key + provider setup)");
        console.error("  • Or set a provider key, e.g.  export OPENROUTER_API_KEY=sk-or-...");
        console.error(`    (also: ${envKeyNames.join(", ")})`);
        console.error("");
        getAppLogger().error(stillMissing, { code: "SESSION_START_FAILED" });
      };
      // Headless / CI / `praana run` must never hang on an overlay.
      if (parsed.runMode || !isInteractive) {
        printMissingProvider();
        process.exit(1);
      }
      needsOnboarding = true;
    }
  }

  // ── Empty-model guard ─────────────────────────────────────
  if (!needsOnboarding && (!config.llm.model || !config.llm.model.trim())) {
    getAppLogger().error("No LLM model configured", {
      code: "SESSION_START_FAILED",
    });
    console.error("");
    console.error("No model is configured for provider:", config.llm.provider);
    console.error('Set [llm] model = "..." in your config or run `praana setup`.');
    console.error("");
    process.exit(1);
  }

  // ── First-run welcome ──────────────────────────────────────
  if (isFirstRun()) {
    markInitialized();
    // Interactive sessions show welcome inside the TUI. Headless keeps a short notice.
    if (!isInteractive) {
      console.log("");
      console.log("  Created ~/.praana/ for config, sessions, and memory.");
      console.log("");
    }
  }

  // ── Headless one-shot (`praana run`) ───────────────────────
  // Runs before the TTY guard — Harbor / CI have no interactive terminal.
  if (parsed.runMode) {
    try {
      await runHeadless({
        cwd,
        config,
        prompt: parsed.runPrompt ?? "",
        maxSteps: parsed.runMaxSteps,
        debug: parsed.debug,
        incognito: parsed.incognito,
      });
      process.exit(0);
    } catch (err) {
      getAppLogger().error("Headless run failed", {
        code: "HEADLESS_RUN_FAILED",
        cause: err as Error,
      });
      console.error((err as Error).message);
      process.exit(1);
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
    console.error("Or use `praana run \"<instruction>\"` for headless one-shot.");
    console.error("");
    process.exit(1);
  }

  const controller = new AppController({ cwd, config, parsed });

  let shuttingDown = false;

  /**
   * Clean shutdown: save the session and exit. Safe to call when no turn is
   * active. Guarded by `shuttingDown` so a second signal can't re-enter.
   */
  const cleanShutdownAndExit = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;

    // SIGINT/SIGTERM before the session exists (Session.create/resume still
    // awaiting during slow startup): nothing to save, just exit.
    if (!controller.session) {
      console.error(`\nReceived ${signal} before session started; exiting.`);
      process.exit(signal === "SIGTERM" ? 143 : 130);
      return;
    }

    console.error(`\nReceived ${signal}, saving session…`);
    try {
      const status = await controller.shutdown();
      if (
        status.turns > 0 ||
        status.stateObjects > 0 ||
        status.rememberCalls > 0
      ) {
        for (const line of formatSessionEndEpilogue({
          sessionId: controller.session.id,
          memory: status.memory,
          turns: status.turns,
          stateObjects: status.stateObjects,
          rememberCalls: status.rememberCalls,
          recallUsed: status.recallUsed,
          learningsStored: status.learningsStored,
        })) {
          console.log(line);
        }
      }
    } catch (err) {
      console.error("Shutdown failed:", (err as Error).message);
    }
    process.exit(signal === "SIGTERM" ? 143 : 130);
  };

  /**
   * Process-level signal handler. The TUI normally captures Ctrl+C itself
   * (raw stdin), so this only fires when the TUI isn't capturing — e.g. during
   * startup, after the TUI exits, or via `kill -INT/-TERM`.
   *
   * - SIGINT during a turn → abort the turn and return to the prompt (branch 1).
   * - SIGTERM during a turn → abort, then terminate (process managers expect exit).
   * - otherwise → clean shutdown + exit.
   */
  const handleShutdownSignal = (signal: NodeJS.Signals) => {
    if (signal === "SIGINT" && controller.isTurnActive()) {
      controller.abortTurn();
      return;
    }
    if (signal === "SIGTERM" && controller.isTurnActive()) {
      controller.abortTurn();
    }
    void cleanShutdownAndExit(signal);
  };

  process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
  process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));

  try {
    if (needsOnboarding) {
      await runTui(controller, undefined, { needsOnboarding: true });
      return;
    }
    if (needsInteractiveEmbedderConsent(config.memory)) {
      await runTui(controller, undefined, { needsEmbedderConsent: true });
      return;
    }
    const info = await controller.start();
    for (const line of info.startupNotices) {
      console.error(line);
    }
    await runTui(controller, info);
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      console.error(`Session not found: ${err.sessionId}`);
      console.error("");
      console.error("List available sessions with:  praana");
      console.error("Then resume with:  praana resume <session-id>");
    } else if (err instanceof AmbiguousSessionPrefixError) {
      console.error(err.message);
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
