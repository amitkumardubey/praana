import { spawn } from "node:child_process";

function isWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function spawnDetached(command: string, args: string[]): boolean {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      // Ignored — caller may try another opener.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort open a URL in the user's default browser.
 * On WSL, prefers wslview / Windows `cmd.exe start` because xdg-open is often a no-op.
 */
export function openBrowserUrl(url: string): void {
  if (isWsl()) {
    if (spawnDetached("wslview", [url])) return;
    if (spawnDetached("cmd.exe", ["/c", "start", "", url])) return;
    spawnDetached("xdg-open", [url]);
    return;
  }

  if (process.platform === "darwin") {
    spawnDetached("open", [url]);
    return;
  }
  if (process.platform === "win32") {
    spawnDetached("cmd", ["/c", "start", "", url]);
    return;
  }
  spawnDetached("xdg-open", [url]);
}
