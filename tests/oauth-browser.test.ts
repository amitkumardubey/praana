import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { openBrowserUrl } from "../src/oauth-browser.js";

describe("OAuth browser opener", () => {
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
      ["cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }],
      ["xdg-open", [url], { detached: true, stdio: "ignore" }],
    ].slice(0, successAt));
    expect(unref).toHaveBeenCalledTimes(1);
  });
  it("reports all unavailable openers without throwing", async () => {
    const fakeSpawn = (() => { throw new Error("unavailable"); }) as typeof spawn;
    expect(await openBrowserUrl("https://example.invalid", { spawn: fakeSpawn, isWsl: true })).toBe(false);
  });
});
