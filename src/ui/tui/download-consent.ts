/**
 * Standalone OpenTUI overlay that asks for consent before downloading the
 * embedding model weights on first run.
 *
 * Returns `true` for Proceed (download), `false` for Cancel (skip —
 * keyword-only recall, which is already a supported, working path).
 *
 * This runs BEFORE the main session TUI starts: the embedder loads during
 * `Session.create()` → `initMemoryStore()` → `createEmbedder()`, which
 * completes before `runTui()` is called in `main.ts`. So a standalone
 * `createCliRenderer()` session is safe — no conflict with the main TUI.
 */
import chalk from "chalk";
import { createCliRenderer, BoxRenderable, TextRenderable } from "@opentui/core";
import { TUI_STYLE } from "./theme.js";

const DOWNLOAD_ITEMS = [
  { value: "proceed", label: "Proceed", description: "Download and enable semantic search" },
  { value: "cancel", label: "Cancel", description: "Skip — keyword-only search still works" },
];

/** Approximate download size hint per known model id. */
const MODEL_SIZE_HINT: Record<string, string> = {
  "Xenova/all-MiniLM-L6-v2": "~38 MB",
  "Xenova/nomic-embed-text-v1": "~277 MB",
};

/**
 * Show a Proceed/Cancel overlay. Resolves `true` if the user picks Proceed,
 * `false` if they pick Cancel or press Ctrl+C.
 */
export async function confirmModelDownload(modelId: string): Promise<boolean> {
  if (!process.stderr.isTTY) return true;

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  try {
    const size = MODEL_SIZE_HINT[modelId] ?? "a small model";

    const box = new BoxRenderable(renderer, {
      id: "download-consent",
      border: true,
      borderStyle: "rounded",
      padding: 1,
      flexDirection: "column",
      width: Math.min(70, (renderer.root.width ?? 80) - 4),
    });
    box.add(new TextRenderable(renderer, { content: TUI_STYLE.heading("Download embedding model?") }));
    box.add(new TextRenderable(renderer, { content: "" }));
    box.add(new TextRenderable(renderer, { content: TUI_STYLE.text("PRAANA's Cognitive Memory uses semantic search for high-quality recall.") }));
    box.add(new TextRenderable(renderer, { content: TUI_STYLE.text(`This requires ${modelId} (${size}), downloaded once from HuggingFace.`) }));
    box.add(new TextRenderable(renderer, { content: "" }));
    box.add(new TextRenderable(renderer, { content: TUI_STYLE.muted("Cancel is safe — keyword-only search still works, just less precise.") }));
    box.add(new TextRenderable(renderer, { content: "" }));
    box.add(new TextRenderable(renderer, { content: TUI_STYLE.info("Press Y to proceed, N to skip.") }));

    renderer.root.add(box);
    renderer.requestRender();

    return await new Promise<boolean>((resolve) => {
      const listener = (data: Buffer) => {
        const key = data.toString().toLowerCase();
        if (key === "y") {
          process.stdin.off("data", listener);
          resolve(true);
        } else if (key === "n" || key === "\u001b") {
          process.stdin.off("data", listener);
          resolve(false);
        }
      };
      process.stdin.on("data", listener);
    });
  } finally {
    renderer.destroy();
  }
}