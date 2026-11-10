import type { PraanaLogger } from "../../logger.js";

/** Keep process warnings off the terminal while the TUI owns it. */
export function routeTuiWarnings(logger: Pick<PraanaLogger, "warn">): () => void {
  const previous = process.rawListeners("warning");
  process.removeAllListeners("warning");
  const handler = (warning: Error) => {
    logger.warn(warning.message, { code: "UNKNOWN", cause: warning });
  };
  process.on("warning", handler);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    process.removeListener("warning", handler);
    for (const listener of previous) process.on("warning", listener as (warning: Error) => void);
  };
}
