/**
 * Standalone Solid TUI: consent before downloading embedding model weights.
 *
 * Returns `true` for Proceed, `false` for Cancel / Ctrl+C / Escape.
 * Runs before the main session TUI (`Session.create` → embedder init).
 */
import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useBindings } from "@opentui/keymap/solid";
import { TUI_STYLE } from "./theme.js";
import { getEmbedderConsent, setEmbedderConsent } from "../../memory/embedder-consent.js";

const DOWNLOAD_OPTIONS = [
  { value: "proceed", name: "Proceed", description: "Download and enable semantic search" },
  { value: "cancel", name: "Cancel", description: "Skip — keyword-only search still works" },
];

const MODEL_SIZE_HINT: Record<string, string> = {
  "Xenova/all-MiniLM-L6-v2": "~38 MB",
  "Xenova/nomic-embed-text-v1": "~277 MB",
};

export function DownloadConsentApp(props: {
  modelId: string;
  sizeHint?: string;
  /** When true, skip the outer bordered box (parent already frames the UI). */
  embedded?: boolean;
  onDone: (proceed: boolean) => void;
}) {
  const sizeHint = props.sizeHint ?? MODEL_SIZE_HINT[props.modelId] ?? "a small model";
  useBindings(() => ({
    bindings: [
      { key: "escape", cmd: () => props.onDone(false) },
      { key: "ctrl+c", cmd: () => props.onDone(false) },
    ],
  }));

  const body = (
    <>
      <text><span style={TUI_STYLE.heading}>Download embedding model?</span></text>
      <text> </text>
      <text>
        PRAANA's Cognitive Memory uses semantic search for high-quality recall.
      </text>
      <text>
        {`This requires ${props.modelId} (${sizeHint}), downloaded once from HuggingFace.`}
      </text>
      <text> </text>
      <text>
        <span style={TUI_STYLE.muted}>Cancel is safe — keyword-only search still works, just less precise.</span>
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
    </>
  );

  if (props.embedded) {
    return <box id="download-consent" flexDirection="column">{body}</box>;
  }

  return (
    <box
      id="download-consent"
      border
      borderStyle="rounded"
      padding={1}
      flexDirection="column"
      width={Math.min(70, (process.stdout.columns ?? 80) - 4)}
    >
      {body}
    </box>
  );
}

/**
 * Show a Proceed/Cancel overlay. Resolves `true` if the user picks Proceed,
 * `false` if they pick Cancel or press Ctrl+C / Escape.
 */
export async function confirmModelDownload(modelId: string): Promise<boolean> {
  const recorded = getEmbedderConsent();
  if (recorded === "proceed") return true;
  if (recorded === "skip") return false;
  if (!process.stderr.isTTY) return true;

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const keymap = createDefaultOpenTuiKeymap(renderer);

  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        setEmbedderConsent(result ? "proceed" : "skip");
        resolve(result);
      };

      void render(
        () => (
          <KeymapProvider keymap={keymap}>
            <DownloadConsentApp
              modelId={modelId}
              onDone={finish}
            />
          </KeymapProvider>
        ),
        renderer,
      );
    });
  } finally {
    renderer.destroy();
  }
}
