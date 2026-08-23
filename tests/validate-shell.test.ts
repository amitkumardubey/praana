import { describe, expect, it } from "bun:test";
import { checkShellCommand, firstToken } from "../src/validate/shell-check.js";

describe("firstToken", () => {
  it("takes the first whitespace token", () => {
    expect(firstToken("echo hi")).toBe("echo");
    expect(firstToken("  bun test")).toBe("bun");
  });
});

describe("checkShellCommand", () => {
  it("allows builtins without PATH", () => {
    expect(checkShellCommand("echo hi", { commandOnPath: () => false })).toBeNull();
  });

  it("allows a token on PATH", () => {
    expect(
      checkShellCommand("bun test", { commandOnPath: (n) => n === "bun" }),
    ).toBeNull();
  });

  it("blocks an unknown first token", () => {
    const err = checkShellCommand("no-such-bin-xyz -v", {
      commandOnPath: () => false,
    });
    expect(err).toContain("no-such-bin-xyz");
  });

  it("blocks a missing cwd", () => {
    const err = checkShellCommand("echo hi", {
      cwd: "/no/such/cwd",
      pathExists: () => false,
      commandOnPath: () => true,
    });
    expect(err).toContain("cwd");
  });
});
