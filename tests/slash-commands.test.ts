import { describe, expect, it, vi } from "vitest";
import { executeSlashCommand } from "../src/slash-commands.js";
import type { Session } from "../src/session.js";

describe("executeSlashCommand", () => {
  it("returns exit action for /exit", async () => {
    const session = {
      stateGraph: { list: () => [] },
    } as unknown as Session;

    const result = await executeSlashCommand("/exit", session, {
      setModel: vi.fn(),
      setThinking: vi.fn(),
      getThinking: () => true,
    });

    expect(result.action).toBe("exit");
    expect(result.lines[0]).toContain("Ending session");
  });

  it("returns refresh_status when model changes", async () => {
    const setModel = vi.fn();
    const session = {
      setModelOverride: vi.fn(),
      getModelOverride: vi.fn(() => null),
      config: { llm: { model: "test/model" } },
      eventLog: { append: vi.fn() },
    } as unknown as Session;

    const result = await executeSlashCommand("/model openai/gpt-4o", session, {
      setModel,
      setThinking: vi.fn(),
      getThinking: () => true,
    });

    expect(result.action).toBe("refresh_status");
    expect(setModel).toHaveBeenCalledWith("openai/gpt-4o");
  });
});
