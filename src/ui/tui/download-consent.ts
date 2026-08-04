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
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type KeyEvent,
} from "@opentui/core";
import { TUI_STYLE } from "./theme.js";

const DOWNLOAD_OPTIONS = [
  { value: "proceed", name: "Proceed", description: "Download and enable semantic search" },
  { value: "cancel", name: "Cancel", description: "Skip — keyword-only search still works" },
];

/** Approximate download size hint per known model id. */
const MODEL_SIZE_HINT: Record<string, string> = {
  "Xenova/all-MiniLM-L6-v2": "~38 MB",
  "Xenova/nomic-embed-text-v1": "~277 MB",
};

/**
 * Show a Proceed/Cancel overlay. Resolves `true` if the user picks Proceed,
 * `false` if they pick Cancel or press Ctrl+C / Escape.
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

    const select = new SelectRenderable(renderer, {
      id: "download-consent-select",
      height: 4,
      width: Math.min(64, (renderer.root.width ?? 80) - 8),
      options: DOWNLOAD_OPTIONS,
      showDescription: true,
      showSelectionIndicator: true,
    });
    box.add(select);

    renderer.root.add(box);
    select.focus();
    renderer.requestRender();

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        renderer.keyInput.off("keypress", onKeypress);
        resolve(result);
      };

      const onKeypress = (key: KeyEvent) => {
        // exitOnCtrlC is false so Ctrl+C arrives here instead of destroying the process.
        if ((key.name === "c" && key.ctrl) || key.name === "escape") {
          finish(false);
        }
      };
      renderer.keyInput.on("keypress", onKeypress);

      select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
        finish(option.value === "proceed");
      });
    });
  } finally {
    renderer.destroy();
  }
}
