import { describe, expect, it } from "bun:test";
import { createRiskPreToolCallHandler } from "../src/hooks/handlers/risk.js";
import type { HookSessionLike } from "../src/hooks/types.js";

function session(
  cwd: string,
  confirmRisk?: HookSessionLike["confirmRisk"],
  plan = false,
): HookSessionLike {
  return { cwd, isPlanMode: () => plan, confirmRisk };
}

describe("risk pre_tool_call", () => {
  it("continues when confirmRisk allows", async () => {
    const pre = createRiskPreToolCallHandler("/proj");
    const out = await pre({
      toolName: "shell",
      args: { command: "rm -rf tmp" },
      session: session("/proj", async () => ({ allowed: true })),
    });
    expect(out).toBeUndefined();
  });

  it("blocks TTY decline with class and command", async () => {
    const pre = createRiskPreToolCallHandler("/proj");
    const out = await pre({
      toolName: "shell",
      args: { command: "rm -rf tmp" },
      session: session("/proj", async () => ({ allowed: false, reason: "declined" })),
    });
    expect(out?.action).toBe("block");
    if (out && out.action === "block") {
      expect(out.error).toBe("User declined rm: rm -rf tmp");
      expect(out.isError).toBe(true);
    }
  });

  it("blocks headless deny with allowlist hint", async () => {
    const pre = createRiskPreToolCallHandler("/proj");
    const out = await pre({
      toolName: "shell",
      args: { command: "npm install x" },
      session: session("/proj", async () => ({ allowed: false, reason: "headless" })),
    });
    expect(out?.action).toBe("block");
    if (out && out.action === "block") {
      expect(out.error).toContain("Blocked in headless (package_install)");
      expect(out.error).toContain("[risk].allow");
    }
  });

  it("fail-closes when confirmRisk is missing", async () => {
    const pre = createRiskPreToolCallHandler("/proj");
    const out = await pre({
      toolName: "shell",
      args: { command: "rm foo" },
      session: session("/proj"),
    });
    expect(out?.action).toBe("block");
    if (out && out.action === "block") {
      expect(out.error).toContain("Blocked in headless (rm)");
    }
  });

  it("treats confirmRisk throw as decline", async () => {
    const pre = createRiskPreToolCallHandler("/proj");
    const out = await pre({
      toolName: "shell",
      args: { command: "rm foo" },
      session: session("/proj", async () => {
        throw new Error("stdin closed");
      }),
    });
    expect(out?.action).toBe("block");
    if (out && out.action === "block") {
      expect(out.error).toBe("User declined rm: rm foo");
    }
  });

  it("skips free tools without calling confirmRisk", async () => {
    let called = 0;
    const pre = createRiskPreToolCallHandler("/proj");
    const out = await pre({
      toolName: "write_file",
      args: { path: "src/a.ts" },
      session: session("/proj", async () => {
        called++;
        return { allowed: true };
      }),
    });
    expect(out).toBeUndefined();
    expect(called).toBe(0);
  });
});
