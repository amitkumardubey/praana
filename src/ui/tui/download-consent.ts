/**
 * Standalone pi-tui overlay that asks for consent before downloading the
 * embedding model weights on first run.
 *
 * Returns `true` for Proceed (download), `false` for Cancel (skip —
 * keyword-only recall, which is already a supported, working path).
 *
 * This runs BEFORE the main session TUI starts: the embedder loads during
 * `Session.create()` → `initMemoryStore()` → `createEmbedder()`, which
 * completes before `runTui()` is called in `main.ts`. So a standalone
 * `new TUI(terminal, true)` session is safe — no conflict with the main TUI.
 */
import chalk from "chalk";
import {
  TUI,
  ProcessTerminal,
  Container,
  Text,
  Spacer,
  SelectList,
  type SelectItem,
  type SelectListTheme,
} from "@earendil-works/pi-tui";
import { TUI_STYLE } from "./theme.js";

const SELECT_THEME: SelectListTheme = {
  selectedPrefix: TUI_STYLE.assistant,
  selectedText: (s: string) => chalk.bold(s),
  description: TUI_STYLE.muted,
  scrollInfo: TUI_STYLE.faint,
  noMatch: TUI_STYLE.muted,
};

const DOWNLOAD_ITEMS: SelectItem[] = [
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
  // Non-interactive environments (tests, CI, piped output) cannot show a TUI
  // overlay. Auto-proceed so the model downloads silently — matching the
  // pre-consent behaviour. In production, Session.create() only runs inside
  // an interactive terminal (main.ts guards with isInteractiveTerminal()).
  if (!process.stderr.isTTY) return true;

  return new Promise((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal, true);

    const root = new Container();
    const header = new Text("", 0, 0);
    const body = new Text("", 0, 0);

    const size = MODEL_SIZE_HINT[modelId] ?? "a small model";

    header.setText(
      [
        chalk.bold("Download embedding model?"),
        "",
        `PRAANA's Cognitive Memory uses semantic search for high-quality recall.`,
        `This requires ${modelId} (${size}), downloaded once from HuggingFace.`,
        "",
        chalk.dim("Cancel is safe — keyword-only search still works, just less precise."),
      ].join("\n"),
    );
    body.setText("Choose:");

    const finish = (result: boolean) => {
      process.removeListener("SIGINT", sigintHandler);
      tui.stop();
      resolve(result);
    };

    const sigintHandler = () => {
      finish(false);
    };
    process.on("SIGINT", sigintHandler);

    const list = new SelectList(DOWNLOAD_ITEMS, 4, SELECT_THEME);
    list.onSelect = (item) => {
      finish(item.value === "proceed");
    };

    root.clear();
    root.addChild(header);
    root.addChild(new Spacer(1));
    root.addChild(body);
    root.addChild(list);

    tui.addChild(root);
    tui.setFocus(list);
    tui.start();
  });
}
