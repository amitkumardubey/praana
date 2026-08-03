import { describe, it, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { IdentityBar } from "../src/ui/tui/chrome/identity-bar.js";
import { GlanceBar } from "../src/ui/tui/chrome/glance-bar.js";

describe("IdentityBar", () => {
  it("shows fallback text before setInput is called", async () => {
    const setup = await createTestRenderer({ width: 40, height: 3 });
    try {
      const bar = new IdentityBar(setup.renderer);
      setup.renderer.root.add(bar);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("praana");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("reflects status updates via setInput", async () => {
    const setup = await createTestRenderer({ width: 60, height: 3 });
    try {
      const bar = new IdentityBar(setup.renderer);
      setup.renderer.root.add(bar);
      bar.setInput({
        model: "openrouter/kimi-k2.7-code",
        repoPath: "/home/user/project",
        cwd: "/home/user/project",
        branch: "main",
        debug: false,
        thinking: false,
        memoryEnabled: true,
        incognito: false,
        planMode: false,
        contextUsedTokens: 1000,
        contextWindowTokens: 5000,
        memoryStats: { active: 1, soft: 2, hard: 0 },
        skills: ["test"],
        loadedSkills: [],
        currentTask: null,
        sessionInputTokens: 100,
        sessionOutputTokens: 50,
      });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("openrouter");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("GlanceBar", () => {
  it("shows initializing state before update is called", async () => {
    const setup = await createTestRenderer({ width: 40, height: 3 });
    try {
      const bar = new GlanceBar(setup.renderer);
      setup.renderer.root.add(bar);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("initializing");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("reflects status updates via update", async () => {
    const setup = await createTestRenderer({ width: 60, height: 3 });
    try {
      const bar = new GlanceBar(setup.renderer);
      setup.renderer.root.add(bar);
      bar.update({
        status: {
          model: "openrouter/kimi-k2.7-code",
          repoPath: "/home/user/project",
          cwd: "/home/user/project",
          branch: "main",
          debug: false,
          thinking: false,
          memoryEnabled: true,
          incognito: false,
          planMode: false,
          contextUsedTokens: 2500,
          contextWindowTokens: 5000,
          memoryStats: { active: 1, soft: 2, hard: 0 },
          skills: ["test"],
          loadedSkills: [],
          currentTask: null,
          sessionInputTokens: 100,
          sessionOutputTokens: 50,
        },
        showCost: false,
      });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("ctx");
    } finally {
      setup.renderer.destroy();
    }
  });
});
