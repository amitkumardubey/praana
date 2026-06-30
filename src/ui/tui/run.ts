/**
 * pi-tui TUI entry — ambient intelligence layout (design §5).
 */
import {
  TUI,
  ProcessTerminal,
  Container,
  Loader,
  Editor,
  CombinedAutocompleteProvider,
  type SlashCommand,
  type AutocompleteProvider,
  type AutocompleteItem,
  matchesKey,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { AppController, StartupInfo } from "../../app-controller.js";
import {
  APP_VERSION,
  formatSessionEndSummary,
} from "../../app-banner.js";
import { formatTuiBootSummary } from "./boot-summary.js";
import { EDITOR_BORDER_STYLE, TUI_STYLE } from "./theme.js";
import { TranscriptContainer } from "./transcript/container.js";
import type { TranscriptEntry } from "./transcript/model.js";
import { TranscriptProjection } from "./transcript/projection.js";
import { IdentityBar } from "./chrome/identity-bar.js";
import { GlanceBar } from "./chrome/glance-bar.js";
import { ToastRegion } from "./toast-region.js";
import { PiTuiSink } from "./sink.js";
import { renderBootBanner } from "./banner.js";
import { DEFAULT_CONTEXT_WINDOW } from "../../status-bar.js";

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

function versionNumber(): string {
  return APP_VERSION.replace(/^v/, "");
}

export async function runTui(
  controller: AppController,
  info: StartupInfo,
): Promise<void> {
  const config = controller.config;
  const session = controller.session;
  const width = process.stdout.columns ?? 80;
  const useUnicode = config.ui.tool_icons === "unicode";

  const bootSummaryLines = formatTuiBootSummary({
    session,
    model: session.getActiveModelLabel(),
    cwd: info.cwd,
    isResume: info.isResume,
  });

  const bannerLines = renderBootBanner({
    version: versionNumber(),
    summaryLines: bootSummaryLines,
    width,
    noColor: !!process.env.NO_COLOR,
    banner: config.ui.banner,
  });
  for (const line of bannerLines) {
    process.stdout.write(line + "\n");
  }

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);

  const identityBar = new IdentityBar();
  identityBar.setBackgroundZones(config.ui.background_zones);
  identityBar.setInput(controller.getStatusBarInput());

  const glanceBar = new GlanceBar(tui);
  glanceBar.setBackgroundZones(config.ui.background_zones);

  const refreshChrome = () => {
    identityBar.setInput(controller.getStatusBarInput());
    glanceBar.update({
      status: controller.getStatusBarInput(),
      showCost: config.ui.show_cost,
      sessionInputTokens: session.getInputTokens(),
      sessionOutputTokens: session.getOutputTokens(),
    });
  };
  refreshChrome();

  const transcriptOpts = {
    markdownRendering: config.ui.markdown_rendering,
    syntaxTheme: config.ui.syntax_theme,
    backgroundZones: config.ui.background_zones,
    useUnicode,
  };
  const projection = new TranscriptProjection({ useUnicode });
  projection.load(info.transcriptBootstrap ?? []);
  const transcript = new TranscriptContainer(
    tui,
    transcriptOpts,
    projection.entries(),
  );

  const toast = new ToastRegion(tui);

  const spinner = new Loader(
    tui,
    TUI_STYLE.assistant,
    TUI_STYLE.muted,
    "thinking…",
    { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 80 },
  );

  const editorTheme = {
    borderColor: EDITOR_BORDER_STYLE,
    selectList: {
      selectedPrefix: TUI_STYLE.assistant,
      selectedText: (s: string) => chalk.bold(s),
      description: TUI_STYLE.muted,
      scrollInfo: TUI_STYLE.faint,
      noMatch: TUI_STYLE.muted,
    },
  };
  const editor = new Editor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });

  const baseProvider = new CombinedAutocompleteProvider(SLASH_COMMANDS, controller.cwd);
  const autocomplete: AutocompleteProvider = {
    getSuggestions: baseProvider.getSuggestions
      ? baseProvider.getSuggestions.bind(baseProvider)
      : async () => null,
    shouldTriggerFileCompletion: baseProvider.shouldTriggerFileCompletion
      ? baseProvider.shouldTriggerFileCompletion.bind(baseProvider)
      : undefined,
    applyCompletion(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      item: AutocompleteItem,
      prefix: string,
    ) {
      const isSlashItem = prefix.startsWith("/") && !prefix.slice(1).includes("/");
      const fixedItem =
        isSlashItem && item.value.startsWith("/")
          ? { ...item, value: item.value.slice(1) }
          : item;
      return baseProvider.applyCompletion(lines, cursorLine, cursorCol, fixedItem, prefix);
    },
  };
  editor.setAutocompleteProvider(autocomplete);

  const spinnerSlot = new Container();
  const body = new Container();
  body.addChild(transcript);
  tui.addChild(body);
  tui.addChild(toast);
  tui.addChild(spinnerSlot);
  tui.addChild(editor);
  // Identity bar sits below the editor, above the glance bar — all three
  // are pinned at the bottom because they are the last children rendered
  // and the viewport always shows the tail of the content buffer.
  tui.addChild(identityBar);
  tui.addChild(glanceBar);
  tui.setFocus(editor);

  const modelId = controller.currentModelOrDefault();
  const ctxWindow =
    session.getContextWindowTokens(modelId) || DEFAULT_CONTEXT_WINDOW;
  const persistTranscriptEntry = (entry: TranscriptEntry) => {
    session.eventLog.append({
      kind: "ui_transcript",
      actor: "kernel",
      payload: { type: "entry", entry },
    });
  };

  const sink = new PiTuiSink(tui, transcript, toast, {
    ambient: config.ui.ambient,
    showThinking: () => controller.showThinking,
    onSpinnerMessage: (msg) => { spinner.setMessage(msg); },
    ctxWindowTokens: ctxWindow,
    ctxUsedTokens: () =>
      controller.getStatusBarInput().contextUsedTokens,
    projection,
    persistEntry: persistTranscriptEntry,
    getModel: () => controller.currentModelOrDefault(),
    onLiveContextGrowth: (extraTokens) => {
      const base = controller.getStatusBarInput();
      glanceBar.update({
        status: {
          ...base,
          contextUsedTokens: base.contextUsedTokens + extraTokens,
        },
        showCost: config.ui.show_cost,
        sessionInputTokens: session.getInputTokens(),
        sessionOutputTokens: session.getOutputTokens(),
      });
    },
  });

  let turnStartedAt = 0;

  editor.onSubmit = async (rawInput: string) => {
    const input = rawInput.trim();
    if (!input) return;
    editor.addToHistory(input);
    toast.clearErrors();

    if (input.startsWith("/")) {
      const result = await controller.executeSlashCommand(input);

      if (result.display === "toast" && result.toastTone) {
        toast.show(
          result.lines.join(" "),
          result.toastTone === "error"
            ? "error"
            : result.toastTone === "success"
              ? "success"
              : "info",
        );
      } else if (result.lines.length > 0) {
        for (const line of result.lines) sink.onFallback(line);
      }

      if (result.action === "exit") {
        await doShutdown();
        return;
      }
      if (result.action === "clear_transcript") {
        projection.apply({ type: "transcript_cleared" });
        transcript.renderEntries([]);
      }
      if (result.action === "refresh_status") {
        refreshChrome();
      }
      tui.requestRender();
      return;
    }

    sink.nextGroup();
    sink.appendUser(input);
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
      refreshChrome();
      tui.requestRender();
    }
  };

  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      const action = controller.handleUserInterrupt();
      if (action === "abort_turn") {
        spinner.stop();
        spinnerSlot.removeChild(spinner);
        editor.disableSubmit = false;
        sink.onFallback("⚡ turn aborted");
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

  async function doShutdown(): Promise<void> {
    editor.disableSubmit = true;
    tui.stop();
    process.stderr.write("\nSaving session…\n");
    const { memory } = await controller.shutdown();

    const summary = session.getSessionSummary();
    const shortId = session.id.slice(0, 4);

    console.log("");
    console.log(TUI_STYLE.memory(" ◆ consolidation — what this session taught praana"));
    console.log("");

    const outcomeParts: string[] = [];
    if (summary.memoriesStored > 0) {
      outcomeParts.push(`learned ${summary.memoriesStored}`);
    }
    const recallUsed = session.getRecallUsedCount();
    if (recallUsed > 0) {
      outcomeParts.push(`reinforced ${recallUsed}`);
    }
    if (outcomeParts.length > 0) {
      console.log(` ${outcomeParts.join(" · ")}`);
      console.log("");
    }

    console.log(
      ` session saved · ${summary.turns} turns · resume with  praana resume ${shortId}`,
    );

    if (memory === "completed") {
      console.log(chalk.dim(" memory saved"));
    } else if (memory === "background") {
      console.log(chalk.dim(" saving in background…"));
    } else if (memory === "skipped" || memory === "noop") {
      console.log(chalk.dim(" memory off"));
    }

    console.log("");
    console.log(chalk.dim(formatSessionEndSummary(session)));
    process.exit(0);
  }

  tui.start();
}
