/**
 * Standalone Solid TUI: consent before downloading embedding model weights.
 *
 * Returns `true` for Proceed, `false` for Cancel / Ctrl+C / Escape.
 * Runs before the main session TUI (`Session.create` → embedder init).
 */
import { createEffect, onCleanup } from "solid-js";
import { createCliRenderer, type KeyEvent } from "@opentui/core";
import { render, useRenderer } from "@opentui/solid";
import { TUI_STYLE } from "./theme.js";

const DOWNLOAD_OPTIONS = [
  { value: "proceed", name: "Proceed", description: "Download and enable semantic search" },
  { value: "cancel", name: "Cancel", description: "Skip — keyword-only search still works" },
];

const MODEL_SIZE_HINT: Record<string, string> = {
  "Xenova/all-MiniLM-L6-v2": "~38 MB",
  "Xenova/nomic-embed-text-v1": "~277 MB",
};

function DownloadConsentApp(props: {
  modelId: string;
  sizeHint: string;
  onDone: (proceed: boolean) => void;
}) {
  const renderer = useRenderer();

  createEffect(() => {
    const onKey = (key: KeyEvent) => {
      if ((key.name === "c" && key.ctrl) || key.name === "escape") {
        props.onDone(false);
      }
    };
    renderer.keyInput.on("keypress", onKey);
    onCleanup(() => {
      renderer.keyInput.off("keypress", onKey);
    });
  });

  return (
    <box
      id="download-consent"
      border
      borderStyle="rounded"
      padding={1}
      flexDirection="column"
      width={Math.min(70, (process.stdout.columns ?? 80) - 4)}
    >
      <text>{TUI_STYLE.heading("Download embedding model?")}</text>
      <text> </text>
      <text>
        {TUI_STYLE.text(
          "PRAANA's Cognitive Memory uses semantic search for high-quality recall.",
        )}
      </text>
      <text>
        {TUI_STYLE.text(
          `This requires ${props.modelId} (${props.sizeHint}), downloaded once from HuggingFace.`,
        )}
      </text>
      <text> </text>
      <text>
        {TUI_STYLE.muted("Cancel is safe — keyword-only search still works, just less precise.")}
      </text>
      <text> </text>
      <select
        id="download-consent-select"
        focused
        height={4}
        width={Math.min(64, (process.stdout.columns ?? 80) - 8)}
        options={DOWNLOAD_OPTIONS}
        showDescription
        showSelectionIndicator
        onSelect={(_index: number, option: { value?: unknown } | null) => {
          props.onDone(option?.value === "proceed");
        }}
      />
    </box>
  );
}

/**
 * Show a Proceed/Cancel overlay. Resolves `true` if the user picks Proceed,
 * `false` if they pick Cancel or press Ctrl+C / Escape.
 */
export async function confirmModelDownload(modelId: string): Promise<boolean> {
  if (!process.stderr.isTTY) return true;

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const sizeHint = MODEL_SIZE_HINT[modelId] ?? "a small model";

  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      void render(
        () => (
          <DownloadConsentApp
            modelId={modelId}
            sizeHint={sizeHint}
            onDone={finish}
          />
        ),
        renderer,
      );
    });
  } finally {
    renderer.destroy();
  }
}
