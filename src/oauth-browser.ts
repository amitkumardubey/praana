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

/**
 * Best-effort open a URL in the user's default browser.
 * On WSL, prefers wslview / Windows `cmd.exe start` because xdg-open is often a no-op.
 */
export async function openBrowserUrl(url: string, deps: BrowserOpenerDeps = {}): Promise<boolean> {
  const spawnChild = deps.spawn ?? spawn;
  const platform = deps.platform ?? process.platform;
  const isWsl = deps.isWsl ?? Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
  if (isWsl) {
    if (await spawnDetached("wslview", [url], spawnChild)) return true;
    if (await spawnDetached("cmd.exe", ["/c", "start", "", url], spawnChild)) return true;
    return spawnDetached("xdg-open", [url], spawnChild);
  }
  if (platform === "darwin") return spawnDetached("open", [url], spawnChild);
  if (platform === "win32") return spawnDetached("cmd", ["/c", "start", "", url], spawnChild);
  return spawnDetached("xdg-open", [url], spawnChild);
}
