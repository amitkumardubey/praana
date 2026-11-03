import { spawn } from "node:child_process";

export interface BrowserOpenerDeps {
  spawn?: typeof spawn;
  platform?: NodeJS.Platform;
  isWsl?: boolean;
}

async function spawnDetached(command: string, args: string[], spawnChild: typeof spawn): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawnChild(command, args, { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => { child.unref(); resolve(true); });
    } catch {
      resolve(false);
    }
  });
}

/** Quote a URL for PowerShell single quotes. `&` stays inside the string. */
function powershellStartCommand(url: string): string {
  return `Start-Process -FilePath '${url.replaceAll("'", "''")}'`;
}

/**
 * Best-effort open a URL in the user's default browser.
 * On WSL, prefers wslview, then PowerShell Start-Process, because xdg-open is often a no-op.
 * The URL is never passed through cmd.exe, which would split on `&`.
 */
export async function openBrowserUrl(url: string, deps: BrowserOpenerDeps = {}): Promise<boolean> {
  if (
    deps.spawn === undefined
    && process.env.NODE_ENV === "test"
    && process.env.PRAANA_OPEN_BROWSER === "0"
  ) return false;
  const spawnChild = deps.spawn ?? spawn;
  const platform = deps.platform ?? process.platform;
  const isWsl = deps.isWsl ?? Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
  if (isWsl) {
    if (await spawnDetached("wslview", [url], spawnChild)) return true;
    if (await spawnDetached("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", powershellStartCommand(url),
    ], spawnChild)) return true;
    return spawnDetached("xdg-open", [url], spawnChild);
  }
  if (platform === "darwin") return spawnDetached("open", [url], spawnChild);
  if (platform === "win32") return spawnDetached("rundll32", ["url.dll,FileProtocolHandler", url], spawnChild);
  return spawnDetached("xdg-open", [url], spawnChild);
}
