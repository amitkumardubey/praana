/**
 * LaunchCanvas (src/ui/tui/launch-canvas.tsx) renders under the OpenTUI
 * test renderer (Solid) — the first-screen hint must always render, using
 * the 80-column form when the terminal width is unknown.
 */
import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { LaunchCanvas } from "../src/ui/tui/launch-canvas.tsx";

describe("LaunchCanvas", () => {
  it("always renders the first-screen hint line", async () => {
    const [version] = createSignal("v0.16.0");
    const [skills] = createSignal("2 skills discovered");
    const setup = await testRender(
      () => <LaunchCanvas version={version} skillsLabel={skills} />,
      { width: 80, height: 24 },
    );
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Type a message");
      expect(frame).toContain("v0.16.0");
      expect(frame).toContain("2 skills discovered");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("uses the short hint form on a narrow 60-column terminal", async () => {
    const [version] = createSignal("v0.16.0");
    const [skills] = createSignal("2 skills discovered");
    const setup = await testRender(
      () => <LaunchCanvas version={version} skillsLabel={skills} />,
      { width: 60, height: 24 },
    );
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Type a message · /help · /model · Ctrl+J = new line");
      expect(frame).not.toContain("Type a message to start");
    } finally {
      setup.renderer.destroy();
    }
  });
});
