import type { CliRenderer } from "@opentui/core";

/** Wait until OpenTUI has rendered the submitted message and spinner. */
export function waitForSubmittedFrame(renderer: Pick<CliRenderer, "once" | "requestRender">): Promise<void> {
  return new Promise((resolve) => {
    renderer.once("frame", () => resolve());
    renderer.requestRender();
  });
}
