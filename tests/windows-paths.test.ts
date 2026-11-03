import { describe, it, expect } from "bun:test";
import { posix, win32 } from "node:path";
import { resolveAgainstCwd } from "../src/app-identity.js";

const WIN_CWD = "D:\\work\\project";

describe("resolveAgainstCwd with Windows paths", () => {
  it("keeps drive-absolute paths unchanged", () => {
    const dbPath = "C:\\Users\\x\\home\\.praana\\memory.db";
    expect(resolveAgainstCwd(dbPath, WIN_CWD, win32)).toBe(dbPath);
  });

  it("keeps UNC paths unchanged", () => {
    const dbPath = "\\\\server\\share\\memory.db";
    expect(resolveAgainstCwd(dbPath, WIN_CWD, win32)).toBe(dbPath);
  });

  it("joins relative paths onto cwd", () => {
    expect(resolveAgainstCwd("memory.db", WIN_CWD, win32)).toBe(
      win32.join(WIN_CWD, "memory.db"),
    );
    expect(resolveAgainstCwd("./data/memory.db", WIN_CWD, win32)).toBe(
      win32.join(WIN_CWD, "./data/memory.db"),
    );
    expect(resolveAgainstCwd(".\\data\\memory.db", WIN_CWD, win32)).toBe(
      win32.join(WIN_CWD, ".\\data\\memory.db"),
    );
  });

  it("keeps the :memory: sentinel", () => {
    expect(resolveAgainstCwd(":memory:", WIN_CWD, win32)).toBe(":memory:");
  });
});

describe("resolveAgainstCwd with POSIX paths", () => {
  it("keeps absolute paths unchanged and joins relative paths", () => {
    expect(resolveAgainstCwd("/var/lib/memory.db", "/work", posix)).toBe(
      "/var/lib/memory.db",
    );
    expect(resolveAgainstCwd("data/memory.db", "/work", posix)).toBe(
      "/work/data/memory.db",
    );
  });
});
