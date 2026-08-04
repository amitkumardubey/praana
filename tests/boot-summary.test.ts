import { describe, it, expect } from "bun:test";
import { formatTuiWelcomeLine } from "../src/ui/tui/boot-summary.js";
import type { Session } from "../src/session.js";

// Minimal Session-shaped stub — only the members the welcome formatter touches.
function stubSession(overrides: Partial<{
  digest: string;
  persistentCount: number;
  engine: boolean;
  skillsCount: number;
  turns: number;
  active: number;
  soft: number;
  hard: number;
}> = {}): Session {
  return {
    digest: overrides.digest ?? "",
    getPersistentMemoryEntryCount: () => overrides.persistentCount ?? 0,
    isContextEngineEnabled: () => overrides.engine ?? false,
    skills: new Array(overrides.skillsCount ?? 0) as unknown as Session["skills"],
    getTurnCount: () => overrides.turns ?? 0,
    getMemoryStats: () => ({
      active: overrides.active ?? 0,
      soft: overrides.soft ?? 0,
      hard: overrides.hard ?? 0,
    }),
  } as unknown as Session;
}

describe("formatTuiWelcomeLine", () => {
  it("leads a fresh session with the app identity and readiness summary", () => {
    const session = stubSession({
      digest: "one\n\ntwo\n",
      persistentCount: 142,
      engine: true,
      skillsCount: 104,
    });
    const line = formatTuiWelcomeLine({
      session,
      model: "umans-glm-5.2",
      cwd: "/tmp",
      isResume: false,
      appName: "PRAANA",
      version: "v0.12.0",
    });
    expect(line).toContain("PRAANA v0.12.0");
    expect(line).toContain("model umans-glm-5.2");
    expect(line).toContain("2 recalled");
    expect(line).toContain("142 in db");
    expect(line).toContain("engine on");
    expect(line).toContain("104 skills");
  });

  it("marks a resumed session with turn + tier count", () => {
    const session = stubSession({ turns: 3, active: 2, soft: 1 });
    const line = formatTuiWelcomeLine({
      session,
      model: "model-x",
      cwd: "/tmp",
      isResume: true,
      appName: "PRAANA",
      version: "0.12.0",
    });
    expect(line).toContain("PRAANA v0.12.0");
    expect(line).toContain("resumed · 3 turns");
    expect(line).toContain("2A·1S restored");
  });

  it("uses praana and no version when not provided", () => {
    const session = stubSession();
    const line = formatTuiWelcomeLine({
      session,
      model: "m",
      cwd: "/tmp",
      isResume: false,
    });
    expect(line).toContain("praana");
    expect(line).not.toContain(" v");
  });
});
