import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SIDECAR_ADDON_FILENAME } from "../native/sidecar.js";

export type InstallKind =
  | "standalone"
  | "brew"
  | "bun_global"
  | "npm_global"
  | "source"
  | "unknown";

export interface ClassifyInstallInput {
  execPath?: string;
  argv?: string[];
  sidecarExists?: boolean | ((sidecarPath: string) => boolean);
}

function firstScriptArg(argv: string[]): string | undefined {
  return argv.find((arg) => arg.endsWith(".ts") || arg.endsWith(".js") || arg.endsWith(".mjs"));
}

function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

export function classifyInstallKind(input: ClassifyInstallInput = {}): InstallKind {
  const execPath = input.execPath ?? process.execPath;
  const argv = input.argv ?? process.argv;
  const script = firstScriptArg(argv) ?? argv[1];
  const scriptPosix = script ? posix(script) : "";

  if (scriptPosix && /(^|\/)src\/main\.ts$/.test(scriptPosix)) return "source";
  if (
    scriptPosix &&
    /(^|\/)bin\/praana\.js$/.test(scriptPosix) &&
    !scriptPosix.includes("node_modules/")
  ) {
    return "source";
  }

  const execPosix = posix(execPath);
  if (/\/Cellar\/praana\//.test(execPosix) || /\/homebrew\//i.test(execPosix)) {
    return "brew";
  }

  const base = basename(execPath);
  const sidecarPath = join(dirname(execPath), SIDECAR_ADDON_FILENAME);
  const sidecarOk =
    typeof input.sidecarExists === "function"
      ? input.sidecarExists(sidecarPath)
      : typeof input.sidecarExists === "boolean"
        ? input.sidecarExists
        : existsSync(sidecarPath);
  if ((base === "praana" || base === "praana.exe") && sidecarOk) {
    return "standalone";
  }

  if (scriptPosix.includes("node_modules/praana/")) {
    if (scriptPosix.includes("/.bun/") || scriptPosix.includes("/bun/install/global/")) {
      return "bun_global";
    }
    return "npm_global";
  }

  return "unknown";
}
