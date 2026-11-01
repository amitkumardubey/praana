import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { openBrowserUrl } from "../src/oauth-browser.js";

describe("OAuth browser opener", () => {
  it("does not spawn a browser when a test opts out", async () => {
    const previous = process.env.PRAANA_OPEN_BROWSER;
    process.env.PRAANA_OPEN_BROWSER = "0";
    try {
      expect(await openBrowserUrl("https://example.invalid/oauth")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PRAANA_OPEN_BROWSER;
      else process.env.PRAANA_OPEN_BROWSER = previous;
    }
  });

  it.each([1, 2, 3])("falls through asynchronous WSL spawn errors (success at %s)", async (successAt) => {
    const calls: Array<[string, string[], unknown]> = [];
    const unref = mock(() => {});
    const fakeSpawn = ((command: string, args: string[], options: unknown) => {
      calls.push([command, args, options]);
      const child = new EventEmitter() as ChildProcess;
      child.unref = unref;
      const succeeds = calls.length === successAt;
      queueMicrotask(() => child.emit(succeeds ? "spawn" : "error", new Error("ENOENT")));
      return child;
    }) as typeof spawn;
    const url = "https://example.invalid/authorize?state=synthetic";
    expect(await openBrowserUrl(url, { spawn: fakeSpawn, isWsl: true })).toBe(true);
    expect(calls).toEqual([
      ["wslview", [url], { detached: true, stdio: "ignore" }],
      ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${url}'`], { detached: true, stdio: "ignore" }],
      ["xdg-open", [url], { detached: true, stdio: "ignore" }],
    ].slice(0, successAt));
    expect(unref).toHaveBeenCalledTimes(1);
  });
  it("passes a URL containing & ' and % without a shell", async () => {
    const url = "https://auth.openai.com/oauth/authorize?a=1&b=o'hare&c=100%";
    const calls: Array<[string, string[]]> = [];
    const fakeSpawn = ((command: string, args: string[]) => {
      calls.push([command, args]);
      const child = new EventEmitter() as ChildProcess;
      child.unref = () => {};
      queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      return child;
    }) as typeof spawn;
    expect(await openBrowserUrl(url, { spawn: fakeSpawn, isWsl: true })).toBe(false);
    expect(calls).toEqual([
      ["wslview", [url]],
      ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath 'https://auth.openai.com/oauth/authorize?a=1&b=o''hare&c=100%'"]],
      ["xdg-open", [url]],
    ]);
    calls.length = 0;
    expect(await openBrowserUrl(url, { spawn: fakeSpawn, platform: "win32", isWsl: false })).toBe(false);
    expect(calls).toEqual([
      ["rundll32", ["url.dll,FileProtocolHandler", url]],
    ]);
  });
  it("reports all unavailable openers without throwing", async () => {
    const fakeSpawn = (() => { throw new Error("unavailable"); }) as typeof spawn;
    expect(await openBrowserUrl("https://example.invalid", { spawn: fakeSpawn, isWsl: true })).toBe(false);
  });
});
