import type { CliRenderer } from "@opentui/core";

/** Wait until OpenTUI has rendered the submitted message and spinner. */
export function waitForSubmittedFrame(renderer: Pick<CliRenderer, "once" | "removeListener" | "requestRender">): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      renderer.removeListener("frame", finish);
      resolve();
    };
    const timer = setTimeout(finish, 100);
    try {
      renderer.once("frame", finish);
      renderer.requestRender();
    } catch {
      finish();
    }
  });
}
