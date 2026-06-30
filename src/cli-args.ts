export interface CliArgs {
  sessionId: string | null;
  resumeMode: boolean;
  initMode: boolean;
  memoryDedupeMode: boolean;
  force: boolean;
  debug: boolean;
  incognito: boolean;
  configPath: string | undefined;
  showHelp: boolean;
}

export function parseCliArgs(args: string[]): CliArgs {
  let sessionId: string | null = null;
  let resumeMode = false;
  let initMode = false;
  let memoryDedupeMode = false;
  let force = false;
  let debug = false;
  let incognito = false;
  let configPath: string | undefined;
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      showHelp = true;
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
    if (args[i] === "resume" && args[i + 1]) {
      resumeMode = true;
      sessionId = args[i + 1];
      i++;
      continue;
    }
    if (args[i] === "init") {
      initMode = true;
      continue;
    }
    if (args[i] === "memory" && args[i + 1] === "dedupe") {
      memoryDedupeMode = true;
      i++;
      continue;
    }
  }

  return {
    sessionId,
    resumeMode,
    initMode,
    memoryDedupeMode,
    force,
    debug,
    incognito,
    configPath,
    showHelp,
  };
}
