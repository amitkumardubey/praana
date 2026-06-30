/**
 * pi-tui TUI entry point.
 *
 * Constructs the full pi-tui component tree, seeds transcript from resume
 * bootstrap, runs the main event loop, and handles shutdown with the
 * consolidation epilogue.
 */
import {
  TUI,
  ProcessTerminal,
  Container,
  Loader,
  Editor,
  CombinedAutocompleteProvider,
  type SlashCommand,
  matchesKey,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { AppController, StartupInfo } from "../../app-controller.js";
import {
  formatSessionEpilogue,
  formatSessionEndSummary,
} from "../../app-banner.js";
import { formatTuiBootSummary } from "./boot-summary.js";
import { PALETTE, NORD_COLORS } from "./theme.js";
import { TranscriptStore } from "./transcript/store.js";
import { TranscriptView } from "./transcript/view.js";
import { IdentityBar } from "./chrome/identity-bar.js";
import { GlanceBar } from "./chrome/glance-bar.js";
import { ToastRegion } from "./toast-region.js";
import { PiTuiSink } from "./sink.js";
import { renderBootBanner } from "./banner.js";
import { estimateTokens } from "../../token-estimate.js";

/** Slash commands exposed to the Editor autocomplete provider. */
const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/exit", description: "End session" },
  { name: "/state", description: "List working-memory state objects" },
  { name: "/stats", description: "Session metadata + memory stats" },
  { name: "/scorecard", description: "Per-session telemetry scorecard" },
  { name: "/digest", description: "Show Cognitive Memory digest" },
  { name: "/events", description: "Show last 20 event-log entries" },
  { name: "/recall", description: "Search Cognitive Memory", argumentHint: "<query>" },
  { name: "/model", description: "Switch model mid-session", argumentHint: "[provider] <id>" },
  { name: "/sessions", description: "List past sessions" },
  { name: "/debug", description: "Toggle debug mode" },
  { name: "/thinking", description: "Toggle reasoning stream", argumentHint: "on|off" },
  { name: "/incognito", description: "Toggle memory persistence", argumentHint: "on|off" },
  { name: "/clear", description: "Clear working-memory state" },
  { name: "/new", description: "Clear working-memory state" },
  { name: "/help", description: "Show all commands" },
];

export async function runTui(
  controller: AppController,
  info: StartupInfo,
): Promise<void> {
  const config = controller.config;
  const session = controller.session;
  const width = process.stdout.columns ?? 80;

  // ── Boot banner ──────────────────────────────────────────────────────────
  const bootSummaryText = formatTuiBootSummary({
    sessionId: session.id,
    contextTokens: session.agentsContext
      ? estimateTokens(session.agentsContext)
      : undefined,
    engineEnabled: session.isContextEngineEnabled(),
    skillCount: session.skills.length,
    memoryEnabled: session.memoryEnabled,
    incognito: session.isIncognito(),
  });

  const bannerLines = renderBootBanner({
    version: "0.9.0",
    summary: bootSummaryText,
    isResume: info.isResume,
    width,
    noColor: !!process.env.NO_COLOR,
    banner: config.ui.banner,
  });
  for (const line of bannerLines) {
    process.stdout.write(line + "\n");
  }

  // ── pi-tui setup ─────────────────────────────────────────────────────────
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);

  // ── Chrome ───────────────────────────────────────────────────────────────
  const model = controller.session.getActiveModelLabel();
  const identityBar = new IdentityBar(model, "0.9.0");
  const glanceBar = new GlanceBar(tui);
  glanceBar.update(controller.getStatusBarInput());

  // ── Transcript ───────────────────────────────────────────────────────────
  const store = new TranscriptStore(tui, info.transcriptBootstrap);
  const transcriptView = new TranscriptView(store, tui, {
    markdownRendering: config.ui.markdown_rendering,
    syntaxTheme: config.ui.syntax_theme,
    backgroundZones: config.ui.background_zones,
    toolIcons: config.ui.tool_icons,
  });

  // ── Toast region ─────────────────────────────────────────────────────────
  const toast = new ToastRegion(tui);

  // ── Spinner ───────────────────────────────────────────────────────────────
  const spinner = new Loader(
    tui,
    (s) => chalk.hex(PALETTE.assistant)(s),
    (s) => chalk.hex(PALETTE.muted)(s),
    "thinking…",
    { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 80 },
  );

  // ── Editor ───────────────────────────────────────────────────────────────
  const editorTheme = {
    borderColor: chalk.hex(PALETTE.border),
    selectList: {
      selectedPrefix: (s: string) => chalk.hex(PALETTE.assistant)(s),
      selectedText: (s: string) => chalk.bold(s),
      description: (s: string) => chalk.hex(PALETTE.muted)(s),
      scrollInfo: (s: string) => chalk.hex(PALETTE.faint)(s),
      noMatch: (s: string) => chalk.hex(PALETTE.muted)(s),
    },
  };
  const editor = new Editor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
  const autocomplete = new CombinedAutocompleteProvider(
    SLASH_COMMANDS,
    controller.cwd,
  );
  editor.setAutocompleteProvider(autocomplete);

  // ── Component tree ────────────────────────────────────────────────────────
  // spinnerSlot is a permanent empty Container positioned just above the
  // editor. The spinner is added into it at turn-start and removed at
  // turn-end; the slot itself renders nothing when empty.
  const spinnerSlot = new Container();
  const body = new Container();
  tui.addChild(identityBar);
  tui.addChild(body);
  tui.addChild(toast);
  tui.addChild(spinnerSlot);
  tui.addChild(editor);
  tui.addChild(glanceBar);
  body.addChild(transcriptView);

  tui.setFocus(editor);

  // ── Sink ──────────────────────────────────────────────────────────────────
  const sink = new PiTuiSink(tui, store, toast, {
    ambient: config.ui.ambient,
    showThinking: () => controller.showThinking,
    onSpinnerMessage: (msg) => { spinner.setMessage(msg); },
  });

  // ── Turn state ────────────────────────────────────────────────────────────
  let turnStartedAt = 0;

  // ── Editor submit handler ─────────────────────────────────────────────────
  editor.onSubmit = async (rawInput: string) => {
    const input = rawInput.trim();
    if (!input) return;
    editor.addToHistory(input);
    toast.clearErrors();

    // Slash command?
    if (input.startsWith("/")) {
      const result = await controller.executeSlashCommand(input);

      if (result.display === "toast" && result.toastTone) {
        toast.show(result.lines.join(" "), result.toastTone === "error" ? "error" : result.toastTone === "success" ? "success" : "info");
      } else if (result.lines.length > 0) {
        for (const line of result.lines) store.addSystemLine(line);
      }

      if (result.action === "exit") {
        await doShutdown();
        return;
      }
      if (result.action === "clear_transcript") {
        store.clear();
      }
      if (result.action === "refresh_status") {
        glanceBar.update(controller.getStatusBarInput());
        identityBar.setModel(session.getActiveModelLabel());
      }
      tui.requestRender();
      return;
    }

    // Regular user turn
    sink.nextGroup();
    store.appendUser(input, 0);
    editor.disableSubmit = true;
    spinnerSlot.addChild(spinner);
    spinner.setMessage("thinking…");
    spinner.start();
    turnStartedAt = Date.now();

    try {
      await controller.runUserTurn(input, sink);
    } finally {
      spinner.stop();
      spinnerSlot.removeChild(spinner);
      editor.disableSubmit = false;
      sink.appendTurnFooter(Date.now() - turnStartedAt);
      glanceBar.update(controller.getStatusBarInput());
      tui.requestRender();
    }
  };

  // ── Ctrl-C handler ────────────────────────────────────────────────────────
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      const action = controller.handleUserInterrupt();
      if (action === "abort_turn") {
        spinner.stop();
        spinnerSlot.removeChild(spinner);
        editor.disableSubmit = false;
        store.addSystemLine("⚡ turn aborted");
        tui.requestRender();
        return { consume: true };
      }
      if (action === "prompt_exit") {
        doShutdown().catch(() => {});
        return { consume: true };
      }
    }
    return undefined;
  });

  // ── Shutdown helper ───────────────────────────────────────────────────────
  async function doShutdown(): Promise<void> {
    editor.disableSubmit = true;
    tui.stop();
    process.stderr.write("\nSaving session…\n");
    const { memory } = await controller.shutdown();
    if (memory === "background") {
      process.stderr.write("Memory save continuing in background…\n");
    }

    // Consolidation epilogue (real data only — no faked learned/reinforced counts)
    console.log("");
    console.log(chalk.hex(NORD_COLORS.nord15)("◆ consolidation"));
    const turns = session.getTurnCount?.() ?? "?";
    console.log(`session saved · ${turns} turns · resume with praana resume ${session.id}`);
    if (memory === "completed") {
      console.log("memory saved");
    } else if (memory === "background") {
      console.log("saving in background…");
    } else if (memory === "skipped" || memory === "noop") {
      console.log("memory off");
    }

    for (const line of formatSessionEpilogue(session.id)) {
      console.log(line);
    }
    console.log(formatSessionEndSummary(session));
    process.exit(0);
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  tui.start();
}
