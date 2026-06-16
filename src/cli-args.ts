import type { UiMode, UiScreenMode } from "./types.js";

export interface CliArgs {
  sessionId: string | null;
  resumeMode: boolean;
  initMode: boolean;
  force: boolean;
  debug: boolean;
  incognito: boolean;
  configPath: string | undefined;
  showHelp: boolean;
  uiMode: UiMode | undefined;
  screenMode: UiScreenMode | undefined;
}

export function parseCliArgs(args: string[]): CliArgs {
  let sessionId: string | null = null;
  let resumeMode = false;
  let initMode = false;
  let force = false;
  let debug = false;
  let incognito = false;
  let configPath: string | undefined;
  let showHelp = false;
  let uiMode: UiMode | undefined;
  let screenMode: UiScreenMode | undefined;

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
    if (args[i] === "--ui" && args[i + 1]) {
      const mode = args[i + 1].toLowerCase();
      if (mode === "tui" || mode === "readline") {
        uiMode = mode;
      }
      i++;
      continue;
    }
    if (args[i] === "--screen" && args[i + 1]) {
      const screen = args[i + 1].toLowerCase();
      if (screen === "preserve" || screen === "alternate") {
        screenMode = screen;
      }
      i++;
      continue;
    }
    if (args[i] === "resume" && args[i + 1]) {
      resumeMode = true;
      sessionId = args[i + 1];
      i++;
    }
    if (args[i] === "init") {
      initMode = true;
      continue;
    }
  }

  return {
    sessionId,
    resumeMode,
    initMode,
    force,
    debug,
    incognito,
    configPath,
    showHelp,
    uiMode,
    screenMode,
  };
}

export function resolveUiMode(
  configMode: UiMode,
  cliMode: UiMode | undefined,
  isInteractive: boolean
): UiMode {
  const mode = cliMode ?? configMode;
  if (mode === "tui" && !isInteractive) return "readline";
  return mode;
}

export function resolveScreenMode(
  configScreen: UiScreenMode,
  cliScreen: UiScreenMode | undefined
): UiScreenMode {
  return cliScreen ?? configScreen;
}
