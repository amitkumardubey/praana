export interface CliArgs {
  sessionId: string | null;
  resumeMode: boolean;
  setupMode: boolean;
  memoryDedupeMode: boolean;
  providersMode: boolean;
  modelsMode: boolean;
  modelsProvider: string | null;
  /** Headless one-shot: `praana run "<instruction>"` (Harbor / CI). */
  runMode: boolean;
  /** Prompt text for runMode (positional or --prompt). */
  runPrompt: string | null;
  /** Optional override for turn.max_steps during headless run. */
  runMaxSteps: number | null;
  allMode: boolean;
  force: boolean;
  debug: boolean;
  incognito: boolean;
  configPath: string | undefined;
  showHelp: boolean;
  versionMode: boolean;
  doctorMode: boolean;
  upgradeMode: boolean;
  homeDir: string | undefined;
}

export function parseCliArgs(args: string[]): CliArgs {
  let sessionId: string | null = null;
  let resumeMode = false;
  let setupMode = false;
  let memoryDedupeMode = false;
  let providersMode = false;
  let modelsMode = false;
  let modelsProvider: string | null = null;
  let runMode = false;
  let runPrompt: string | null = null;
  let runMaxSteps: number | null = null;
  let allMode = false;
  let force = false;
  let debug = false;
  let incognito = false;
  let configPath: string | undefined;
  let showHelp = false;
  let versionMode = false;
  let doctorMode = false;
  let upgradeMode = false;
  let homeDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      showHelp = true;
      continue;
    }
    if (args[i] === "--version" || args[i] === "-v") {
      versionMode = true;
      continue;
    }
    if (args[i] === "--all") {
      allMode = true;
      continue;
    }
    if (args[i] === "--force" || args[i] === "-f") {
      force = true;
      continue;
    }
    if (args[i] === "--debug" || args[i] === "-d") {
      debug = true;
      continue;
    }
    if (args[i] === "--incognito" || args[i] === "-I") {
      incognito = true;
      continue;
    }
    if ((args[i] === "--config" || args[i] === "-c") && args[i + 1]) {
      configPath = args[i + 1];
      i++;
      continue;
    }
    if ((args[i] === "--home-dir" || args[i] === "-H") && args[i + 1]) {
      homeDir = args[i + 1];
      i++;
      continue;
    }
    if (args[i] === "resume") {
      resumeMode = true;
      if (args[i + 1] && !args[i + 1].startsWith("-")) {
        sessionId = args[i + 1];
        i++;
      }
      continue;
    }
    if (args[i] === "setup" || args[i] === "init") {
      setupMode = true;
      continue;
    }
    if (args[i] === "doctor") {
      doctorMode = true;
      continue;
    }
    if (args[i] === "upgrade" || args[i] === "update") {
      upgradeMode = true;
      continue;
    }
    if (args[i] === "providers") {
      providersMode = true;
      continue;
    }
    if (args[i] === "models") {
      modelsMode = true;
      if (args[i + 1] && !args[i + 1].startsWith("-")) {
        modelsProvider = args[i + 1];
        i++;
      }
      continue;
    }
    if (args[i] === "memory" && args[i + 1] === "dedupe") {
      memoryDedupeMode = true;
      i++;
      continue;
    }
    if (args[i] === "run") {
      runMode = true;
      // Consume remaining args as run options / prompt.
      for (let j = i + 1; j < args.length; j++) {
        if ((args[j] === "--prompt" || args[j] === "-p") && args[j + 1]) {
          runPrompt = args[j + 1];
          j++;
          continue;
        }
        if ((args[j] === "--max-steps" || args[j] === "-n") && args[j + 1]) {
          const n = Number.parseInt(args[j + 1], 10);
          if (Number.isFinite(n) && n > 0) runMaxSteps = n;
          j++;
          continue;
        }
        if (args[j] === "--help" || args[j] === "-h") {
          showHelp = true;
          continue;
        }
        if (args[j] === "--debug" || args[j] === "-d") {
          debug = true;
          continue;
        }
        if (args[j] === "--incognito" || args[j] === "-I") {
          incognito = true;
          continue;
        }
        if ((args[j] === "--config" || args[j] === "-c") && args[j + 1]) {
          configPath = args[j + 1];
          j++;
          continue;
        }
        if (args[j].startsWith("-")) {
          // Unknown run flag — ignore for forward-compat.
          continue;
        }
        // First positional after `run` is the prompt (unless --prompt already set).
        if (runPrompt === null) {
          runPrompt = args[j];
        }
      }
      break;
    }
  }

  return {
    sessionId,
    resumeMode,
    setupMode,
    memoryDedupeMode,
    providersMode,
    modelsMode,
    modelsProvider,
    runMode,
    runPrompt,
    runMaxSteps,
    allMode,
    force,
    debug,
    incognito,
    configPath,
    showHelp,
    versionMode,
    doctorMode,
    upgradeMode,
    homeDir,
  };
}
