export interface CliArgs {
  sessionId: string | null;
  resumeMode: boolean;
  initMode: boolean;
  memoryDedupeMode: boolean;
  providersMode: boolean;
  force: boolean;
  debug: boolean;
  incognito: boolean;
  configPath: string | undefined;
  showHelp: boolean;
  versionMode: boolean;
  doctorMode: boolean;
  homeDir: string | undefined;
}

export function parseCliArgs(args: string[]): CliArgs {
  let sessionId: string | null = null;
  let resumeMode = false;
  let initMode = false;
  let memoryDedupeMode = false;
  let providersMode = false;
  let force = false;
  let debug = false;
  let incognito = false;
  let configPath: string | undefined;
  let showHelp = false;
  let versionMode = false;
  let doctorMode = false;
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
    if (args[i] === "--providers" || args[i] === "-p") {
      providersMode = true;
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
    if (args[i] === "doctor") {
      doctorMode = true;
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
    providersMode,
    force,
    debug,
    incognito,
    configPath,
    showHelp,
    versionMode,
    doctorMode,
    homeDir,
  };
}
