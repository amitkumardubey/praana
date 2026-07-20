/**
 * pi-tui TUI entry — ambient intelligence layout (design §5).
 */
import {
  installPiTuiLogRedirect,
  rewritePiTuiCrashErrorMessage,
} from "./redirect-pi-logs.js";

// ⚠️ Import-time side effect. This module must patch `node:fs` before the
// `@earendil-works/pi-tui` import is evaluated, because pi-tui resolves the
// fs functions it will use at load time. Any test or script that imports this
// module will therefore install the redirect. See the ADR in
// redirect-pi-logs.ts for why this is unavoidable today.
installPiTuiLogRedirect();

import {
  TUI,
  ProcessTerminal,
  Container,
  Loader,
  CombinedAutocompleteProvider,
  type SlashCommand,
  type AutocompleteProvider,
  type AutocompleteItem,
  type OverlayHandle,
  matchesKey,
} from "@earendil-works/pi-tui";
import { InvertedEditor } from "./inverted-editor.js";
import chalk from "chalk";
import type { AppController, StartupInfo } from "../../app-controller.js";
import {
  APP_VERSION,
  formatSessionEndEpilogue,
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
import { SlashCommandResultOverlay } from "./slash-command-overlay.js";
import { ModelSelector } from "./model-selector.js";
import { LoginWizard } from "./login-wizard.js";
import { listAllAvailableModels } from "../../model-listing.js";
import { renderBootBanner } from "./banner.js";
import { SLASH_COMMAND_METADATA } from "../../slash-commands.js";

function statusBarFromSnapshot(
  base: StatusBarInput,
  snapshot: ContextDisplaySnapshot,
): StatusBarInput {
  return {
    ...base,
    contextUsedTokens: snapshot.usedTokens,
    contextWindowTokens: snapshot.windowTokens,
    contextDisplayMode: snapshot.mode,
    contextWeightedPct: snapshot.weightedPct,
    contextRawPct: snapshot.rawPct,
    contextPressureMode: snapshot.pressureMode,
  };
}

import { DEFAULT_CONTEXT_WINDOW, type StatusBarInput } from "../../status-bar.js";
import type { ContextDisplaySnapshot } from "../../context-display.js";
import type { SlashCommandToastTone } from "../../slash-commands.js";

function toastToneToType(
  tone: SlashCommandToastTone,
): "error" | "success" | "info" {
  if (tone === "error") return "error";
  if (tone === "success") return "success";
  return "info";
}

// Derived from the single source of truth in slash-commands.ts so the
// autocomplete dropdown can never drift from the real command set.
const SLASH_COMMANDS: SlashCommand[] = SLASH_COMMAND_METADATA.map((c) => ({
  name: c.name,
  description: c.description,
  ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
}));

function versionNumber(): string {
  return APP_VERSION.replace(/^v/, "");
}

export async function runTui(
  controller: AppController,
  info: StartupInfo,
): Promise<void> {
  let config = controller.config;
  let session = controller.session;
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

  let piSink: PiTuiSink | null = null;
  const refreshChrome = () => {
    const base = controller.getStatusBarInput();
    const preview = piSink?.getContextPreview() ?? null;
    identityBar.setInput(base);
    glanceBar.update({
      status: preview ? statusBarFromSnapshot(base, preview) : base,
      showCost: config.ui.show_cost,
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
  const slashOverlay = new SlashCommandResultOverlay();
  let slashOverlayHandle: OverlayHandle | null = null;

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
  const editor = new InvertedEditor(tui, editorTheme, { autocompleteMaxVisible: 12, paddingY: 0 });

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
  editor.inner.setAutocompleteProvider(autocomplete);

  const spinnerSlot = new Container();
  const promptSlot = new Container();
  promptSlot.addChild(editor);
  const body = new Container();
  body.addChild(transcript);
  tui.addChild(body);
  tui.addChild(toast);
  tui.addChild(spinnerSlot);
  tui.addChild(promptSlot);
  // Identity bar sits below the editor, above the glance bar — all three
  // are pinned at the bottom because they are the last children rendered
  // and the viewport always shows the tail of the content buffer.
  tui.addChild(identityBar);
  tui.addChild(glanceBar);
  tui.setFocus(editor);

  const closeModelSelector = () => {
    promptSlot.clear();
    promptSlot.addChild(editor);
    tui.setFocus(editor);
    tui.requestRender();
  };

  const openModelSelector = () => {
    if (slashOverlayHandle && !slashOverlayHandle.isHidden()) {
      slashOverlayHandle.hide();
      slashOverlayHandle = null;
    }

    const selector = new ModelSelector({
      tui,
      currentProvider: session.getEffectiveProvider(),
      currentModelId: session.getActiveModelId(),
      maxVisible: Math.max(6, Math.min(12, (process.stdout.rows ?? 24) - 14)),
      loadModels: () => listAllAvailableModels(),
      onCancel: () => closeModelSelector(),
      onSelect: (provider, modelId) => {
        void (async () => {
          closeModelSelector();
          editor.inner.disableSubmit = true;
          spinnerSlot.addChild(spinner);
          spinner.setMessage("switching model…");
          spinner.start();

          let switchResult: import("../../slash-commands.js").SlashCommandResult;
          try {
            switchResult = await controller.executeSlashCommand(
              `/model ${provider} ${modelId}`,
            );
          } finally {
            spinner.stop();
            spinnerSlot.removeChild(spinner);
            editor.inner.disableSubmit = false;
          }

          if (switchResult.display === "toast" && switchResult.toastTone) {
            toast.show(
              switchResult.lines.join(" "),
              toastToneToType(switchResult.toastTone),
            );
          } else if (switchResult.lines.length > 0) {
            toast.show(switchResult.lines.join(" "), "info");
          }
          if (switchResult.action === "refresh_status") {
            refreshChrome();
          }
          tui.requestRender();
        })();
      },
    });

    promptSlot.clear();
    promptSlot.addChild(selector);
    tui.setFocus(selector);
    selector.start();
    tui.requestRender(true);
  };

  const closeLoginWizard = () => {
    promptSlot.clear();
    promptSlot.addChild(editor);
    tui.setFocus(editor);
    tui.requestRender();
  };

  const openLoginWizard = (providerHint?: string) => {
    if (slashOverlayHandle && !slashOverlayHandle.isHidden()) {
      slashOverlayHandle.hide();
      slashOverlayHandle = null;
    }

    const wizard = new LoginWizard({
      tui,
      currentProvider: session.getEffectiveProvider(),
      initialProvider: providerHint,
      onComplete: (result) => {
        closeLoginWizard();

        if (result.shouldSwitch && result.defaultModel) {
          editor.inner.disableSubmit = true;
          spinnerSlot.addChild(spinner);
          spinner.setMessage("switching model…");
          spinner.start();

          void (async () => {
            let switchResult: import("../../slash-commands.js").SlashCommandResult;
            try {
              switchResult = await controller.executeSlashCommand(
                `/model ${result.provider} ${result.defaultModel}`,
              );
            } finally {
              spinner.stop();
              spinnerSlot.removeChild(spinner);
              editor.inner.disableSubmit = false;
            }

            if (switchResult.display === "toast" && switchResult.toastTone) {
              toast.show(
                switchResult.lines.join(" "),
                toastToneToType(switchResult.toastTone),
              );
            } else if (switchResult.lines.length > 0) {
              toast.show(switchResult.lines.join(" "), "info");
            }
            if (switchResult.action === "refresh_status") {
              refreshChrome();
            }
            tui.requestRender();
          })();
        } else if (result.shouldSwitch) {
          // No default model — just switch the provider
          session.setProviderOverride(result.provider);
          toast.show(result.message, "success");
          refreshChrome();
          tui.requestRender();
        } else {
          // Custom or user-declared — just show the message
          const tone: "info" | "success" =
            result.message.includes("Run /new") ? "info" : "success";
          toast.show(result.message, tone);
          refreshChrome();
          tui.requestRender();
        }
      },
      onCancel: () => closeLoginWizard(),
    });

    promptSlot.clear();
    promptSlot.addChild(wizard);
    tui.setFocus(wizard);
    tui.requestRender(true);
  };

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

  const showSlashOverlay = (lines: string[]) => {
    slashOverlay.setLines(lines);
    if (slashOverlayHandle && !slashOverlayHandle.isHidden()) {
      tui.requestRender();
      return;
    }
    slashOverlayHandle = tui.showOverlay(slashOverlay, {
      anchor: "bottom-center",
      width: "75%",
      maxHeight: "50%",
      margin: { top: 2, bottom: 6 },
      nonCapturing: true,
    });
  };

  const sink = new PiTuiSink(tui, transcript, toast, {
    ambient: config.ui.ambient,
    showThinking: () => controller.showThinking,
    onSpinnerMessage: (msg) => { spinner.setMessage(msg); },
    ctxWindowTokens: ctxWindow,
    engineMode: session.isContextEngineEnabled(),
    projection,
    persistEntry: persistTranscriptEntry,
    getModel: () => controller.currentModelOrDefault(),
    onSlashCommandResult: showSlashOverlay,
    onContextPreview: (snapshot) => {
      glanceBar.update({
        status: statusBarFromSnapshot(controller.getStatusBarInput(), snapshot),
        showCost: config.ui.show_cost,
      });
    },
  });
  piSink = sink;

  let turnStartedAt = 0;

  editor.inner.onSubmit = async (rawInput: string) => {
    let input = rawInput.trim();
    if (!input) return;
    editor.inner.addToHistory(input);
    toast.clearErrors();

    if (input.startsWith("!")) {
      const command = input.slice(1).trim();
      if (!command) {
        toast.show("Usage: !<command>", "error");
        return;
      }
      input = `/shell ${command}`;
    }

    if (input.startsWith("/")) {
      editor.inner.disableSubmit = true;
      spinnerSlot.addChild(spinner);
      spinner.setMessage("running command…");
      spinner.start();

      let result: import("../../slash-commands.js").SlashCommandResult;
      try {
        result = await controller.executeSlashCommand(input);
      } finally {
        spinner.stop();
        spinnerSlot.removeChild(spinner);
        editor.inner.disableSubmit = false;
      }

      if (result.display === "inline_transcript") {
        sink.nextGroup();
        sink.appendUser(input);
        if (result.shellRun) {
          sink.appendShellRun(result.shellRun);
        } else if (result.lines.length > 0) {
          sink.onSystemLines(result.lines);
        }
      } else if (result.display === "toast" && result.toastTone) {
        toast.show(
          result.lines.join(" "),
          toastToneToType(result.toastTone),
        );
      } else if (result.lines.length > 0) {
        sink.onSlashCommandResult?.(result.lines);
      }

      if (result.action === "exit") {
        await doShutdown();
        return;
      }
      if (result.action === "clear_transcript") {
        projection.apply({ type: "transcript_cleared" });
        transcript.renderEntries([]);
        piSink?.clearContextPreview();
        refreshChrome();
      }
      if (result.action === "new_session") {
        const newInfo = await controller.startNewSession();
        config = controller.config;
        session = controller.session;

        projection.apply({ type: "transcript_cleared" });
        transcript.renderEntries([]);
        piSink?.clearContextPreview();

        // Re-apply startup-time configuration that may have changed.
        identityBar.setBackgroundZones(config.ui.background_zones);
        glanceBar.setBackgroundZones(config.ui.background_zones);
        transcriptOpts.markdownRendering = config.ui.markdown_rendering;
        transcriptOpts.syntaxTheme = config.ui.syntax_theme;
        transcriptOpts.backgroundZones = config.ui.background_zones;
        transcriptOpts.useUnicode = config.ui.tool_icons === "unicode";
        projection.setUseUnicode(transcriptOpts.useUnicode);

        // Render the new-session banner into the transcript.
        sink.onSystemLines(newInfo.bannerLines);
        sink.nextGroup();

        refreshChrome();
      }
      if (result.action === "refresh_status") {
        refreshChrome();
      }
      if (result.action === "open_model_selector") {
        openModelSelector();
        return;
      }
      if (result.action === "open_login_wizard") {
        openLoginWizard(result.loginProviderHint);
        return;
      }
      tui.requestRender();
      return;
    }

    sink.nextGroup();
    sink.appendUser(input);
    editor.inner.disableSubmit = true;
    spinnerSlot.addChild(spinner);
    spinner.setMessage("thinking…");
    spinner.start();
    turnStartedAt = Date.now();

    try {
      await controller.runUserTurn(input, sink);
    } finally {
      spinner.stop();
      spinnerSlot.removeChild(spinner);
      editor.inner.disableSubmit = false;
      sink.appendTurnFooter(Date.now() - turnStartedAt);
      refreshChrome();
      tui.requestRender();
    }
  };

  tui.addInputListener((data) => {
    if (slashOverlayHandle && !slashOverlayHandle.isHidden()) {
      if (
        data === "\r" ||
        data === "\n" ||
        matchesKey(data, "escape") ||
        data === "q"
      ) {
        slashOverlayHandle.hide();
        slashOverlayHandle = null;
        return { consume: true };
      }
      // Any other key dismisses the overlay without consuming it.
      slashOverlayHandle.hide();
      slashOverlayHandle = null;
    }

    if (matchesKey(data, "ctrl+c")) {
      // Three-way interrupt: working → abort turn; idle + text → clear input;
      // idle + empty → exit the app.
      const action = controller.handleUserInterrupt(
        editor.inner.getText().length === 0,
      );
      if (action === "abort_turn") {
        spinner.stop();
        spinnerSlot.removeChild(spinner);
        editor.inner.disableSubmit = false;
        sink.onFallback("⚡ turn aborted");
        tui.requestRender();
        return { consume: true };
      }
      if (action === "clear_input") {
        editor.inner.setText("");
        tui.requestRender();
        return { consume: true };
      }
      if (action === "exit") {
        void doShutdown();
        return { consume: true };
      }
      // "noop" — rapid repeat inside the debounce window; swallow it.
      return { consume: true };
    }
    return undefined;
  });

  async function doShutdown(): Promise<void> {
    editor.inner.disableSubmit = true;
    tui.stop();
    // Clear any leftover TTY/editor glyph after unmount (issue #181 stray char).
    process.stderr.write("\r\x1b[2K\nSaving session…\n");
    const status = await controller.shutdown();

    for (const line of formatSessionEndEpilogue({
      sessionId: session.id,
      memory: status.memory,
      turns: status.turns,
      stateObjects: status.stateObjects,
      rememberCalls: status.rememberCalls,
      recallUsed: status.recallUsed,
      learningsStored: status.learningsStored,
    })) {
      console.log(line);
    }
    process.exit(0);
  }

  try {
    tui.start();
  } catch (err) {
    if (err instanceof Error && err.message.includes("Debug log written to:")) {
      err.message = rewritePiTuiCrashErrorMessage(err.message);
    }
    throw err;
  }
}
