/**
 * OpenTUI entry — ambient intelligence layout (design §5).
 */
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
  type CliRenderer,
} from "@opentui/core";
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
import {
  resolveExpandedContent,
  type TranscriptIndex,
} from "./transcript/index.js";
import type { TranscriptEntry } from "./transcript/model.js";
import { TranscriptProjection } from "./transcript/projection.js";
import { IdentityBar } from "./chrome/identity-bar.js";
import { GlanceBar } from "./chrome/glance-bar.js";
import { ToastRegion } from "./toast-region.js";
import { OpenTuiSink } from "./sink.js";
import { showSlashCommandResult, dismissSlashCommandResult } from "./slash-command-overlay.js";
import { ModelSelector } from "./model-selector.js";
import { LoginWizard } from "./login-wizard.js";
import { LogoutWizard } from "./logout-wizard.js";
import { listAllAvailableModels } from "../../model-listing.js";
import { renderBootBanner } from "./banner.js";
import { SLASH_COMMAND_METADATA } from "../../slash-commands.js";
import { Spinner } from "./spinner.js";

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

function indexToEntries(index: TranscriptIndex): TranscriptEntry[] {
  return index.groups.flatMap((group) => group.entries);
}

function toastToneToType(
  tone: SlashCommandToastTone,
): "error" | "success" | "info" {
  if (tone === "error") return "error";
  if (tone === "success") return "success";
  return "info";
}

function matchesKey(key: KeyEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split("+");
  const hasCtrl = parts.includes("ctrl");
  const hasMeta = parts.includes("meta") || parts.includes("cmd");
  const hasShift = parts.includes("shift");
  const name = parts.filter((p) => !["ctrl", "meta", "cmd", "shift"].includes(p))[0];

  return (
    key.ctrl === hasCtrl &&
    key.meta === hasMeta &&
    key.shift === hasShift &&
    key.name === name
  );
}

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

  const renderer = await createCliRenderer({
    stdin: process.stdin,
    stdout: process.stdout,
    width: process.stdout.columns ?? 80,
    height: process.stdout.rows ?? 24,
    exitOnCtrlC: false,
  });

  const ctx: RenderContext = renderer;
  const root = new BoxRenderable(ctx, { id: "tui-root", flexDirection: "column" });

  const transcriptOpts = {
    markdownRendering: config.ui.markdown_rendering,
    syntaxTheme: config.ui.syntax_theme,
    backgroundZones: config.ui.background_zones,
    useUnicode,
  };
  const projection = new TranscriptProjection({ useUnicode });
  projection.load(indexToEntries(info.transcriptBootstrap ?? { groups: [] }));

  const identityBar = new IdentityBar(ctx);
  identityBar.setBackgroundZones(config.ui.background_zones);
  identityBar.setInput(controller.getStatusBarInput());

  const glanceBar = new GlanceBar(ctx);
  glanceBar.setBackgroundZones(config.ui.background_zones);

  const refreshChrome = () => {
    const base = controller.getStatusBarInput();
    const preview = openTuiSink?.getContextPreview() ?? null;
    identityBar.setInput(base);
    glanceBar.update({
      status: preview ? statusBarFromSnapshot(base, preview) : base,
      showCost: config.ui.show_cost,
    });
  };

  const transcript = new TranscriptContainer(
    ctx,
    transcriptOpts,
    undefined,
    {
      onExpand: (entry) =>
        Promise.resolve(
          resolveExpandedContent(entry, session.eventLog.readAll()),
        ),
      onRequestFocus: (target: unknown) => {
        const t = target as { focus?: () => void } | null;
        if (t?.focus) t.focus();
        else editor.focus();
      },
    },
  );
  transcript.loadIndex(info.transcriptBootstrap ?? { groups: [] });

  const toast = new ToastRegion(ctx);
  const spinner = new Spinner(ctx, "thinking…");

  const editor = new InvertedEditor(ctx, { paddingY: 0 });

  const body = new BoxRenderable(ctx, { id: "body", flexDirection: "column", flexGrow: 1 });
  body.add(transcript);

  const promptSlot = new BoxRenderable(ctx, { id: "prompt-slot", flexDirection: "column" });
  promptSlot.add(editor);

  const spinnerSlot = new BoxRenderable(ctx, { id: "spinner-slot", flexDirection: "column" });

  root.add(body);
  root.add(toast);
  root.add(spinnerSlot);
  root.add(promptSlot);
  root.add(identityBar);
  root.add(glanceBar);

  renderer.root.add(root);

  let slashOverlayHandle: import("./overlay.js").OverlayHandle | null = null;

  const clearSlot = (slot: BoxRenderable) => {
    for (const child of slot.getChildren()) {
      slot.remove(child);
    }
  };

  const closeModelSelector = () => {
    clearSlot(promptSlot);
    promptSlot.add(editor);
    editor.focus();
    renderer.requestRender();
  };

  const openModelSelector = () => {
    if (slashOverlayHandle) {
      dismissSlashCommandResult(renderer, slashOverlayHandle);
      slashOverlayHandle = null;
    }

    const selector = new ModelSelector(ctx, {
      currentProvider: session.getEffectiveProvider(),
      currentModelId: session.getActiveModelId(),
      maxVisible: Math.max(6, Math.min(12, (process.stdout.rows ?? 24) - 14)),
      loadModels: () => listAllAvailableModels(),
      onCancel: () => closeModelSelector(),
      onSelect: (provider: string, modelId: string) => {
        void (async () => {
          closeModelSelector();
          spinnerSlot.add(spinner);
          spinner.setMessage("switching model…");

          let switchResult: import("../../slash-commands.js").SlashCommandResult;
          try {
            switchResult = await controller.executeSlashCommand(
              `/model ${provider} ${modelId}`,
            );
          } finally {
            spinner.stop();
            spinnerSlot.remove(spinner);
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
          renderer.requestRender();
        })();
      },
    });

    clearSlot(promptSlot);
    promptSlot.add(selector);
    selector.focus();
    renderer.requestRender();
  };

  const closeLoginWizard = () => {
    clearSlot(promptSlot);
    promptSlot.add(editor);
    editor.focus();
    renderer.requestRender();
  };

  const openLoginWizard = (providerHint?: string) => {
    if (slashOverlayHandle) {
      dismissSlashCommandResult(renderer, slashOverlayHandle);
      slashOverlayHandle = null;
    }

    const wizard = new LoginWizard(ctx, undefined, {
      currentProvider: session.getEffectiveProvider(),
      initialProvider: providerHint,
      onComplete: (result: import("./login-wizard.js").LoginWizardResult) => {
        closeLoginWizard();

        if (result.shouldSwitch && result.defaultModel) {
          spinnerSlot.add(spinner);
          spinner.setMessage("switching model…");

          void (async () => {
            let switchResult: import("../../slash-commands.js").SlashCommandResult;
            try {
              switchResult = await controller.executeSlashCommand(
                `/model ${result.provider} ${result.defaultModel}`,
              );
            } finally {
              spinner.stop();
              spinnerSlot.remove(spinner);
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
            renderer.requestRender();
          })();
        } else if (result.shouldSwitch) {
          session.setProviderOverride(result.provider);
          toast.show(result.message, "success");
          refreshChrome();
          renderer.requestRender();
        } else {
          const tone: "info" | "success" =
            result.message.includes("Run /new") ? "info" : "success";
          toast.show(result.message, tone);
          refreshChrome();
          renderer.requestRender();
        }
      },
      onCancel: () => closeLoginWizard(),
    });

    clearSlot(promptSlot);
    promptSlot.add(wizard);
    wizard.focus();
    renderer.requestRender();
  };

  const closeLogoutWizard = () => {
    clearSlot(promptSlot);
    promptSlot.add(editor);
    editor.focus();
    renderer.requestRender();
  };

  const openLogoutWizard = () => {
    if (slashOverlayHandle) {
      dismissSlashCommandResult(renderer, slashOverlayHandle);
      slashOverlayHandle = null;
    }

    const wizard = new LogoutWizard(ctx, [], {
      currentProvider: session.getEffectiveProvider(),
      onComplete: (result: import("./logout-wizard.js").LogoutWizardResult) => {
        closeLogoutWizard();
        const tone: "info" | "success" =
          result.message.includes("Run /new") ? "info" : "success";
        toast.show(result.message, tone);
        refreshChrome();
        renderer.requestRender();
      },
      onCancel: () => closeLogoutWizard(),
    });

    clearSlot(promptSlot);
    promptSlot.add(wizard);
    wizard.focus();
    renderer.requestRender();
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
    if (slashOverlayHandle) {
      dismissSlashCommandResult(renderer, slashOverlayHandle);
    }
    slashOverlayHandle = showSlashCommandResult(renderer, lines);
  };

  const openTuiSink = new OpenTuiSink(ctx, transcript, toast, {
    ambient: config.ui.ambient,
    showThinking: () => controller.showThinking,
    onSpinnerMessage: (msg: string) => { spinner.setMessage(msg); },
    ctxWindowTokens: ctxWindow,
    engineMode: session.isContextEngineEnabled(),
    projection,
    persistEntry: persistTranscriptEntry,
    getModel: () => controller.currentModelOrDefault(),
    onSlashCommandResult: showSlashOverlay,
    onContextPreview: (snapshot: ContextDisplaySnapshot) => {
      glanceBar.update({
        status: statusBarFromSnapshot(controller.getStatusBarInput(), snapshot),
        showCost: config.ui.show_cost,
      });
    },
  });

  refreshChrome();

  let turnStartedAt = 0;

  editor.onSubmit = async (rawInput: string) => {
    let input = rawInput.trim();
    if (!input) return;
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
      spinnerSlot.add(spinner);
      spinner.setMessage("running command…");

      let result: import("../../slash-commands.js").SlashCommandResult;
      try {
        result = await controller.executeSlashCommand(input);
      } finally {
        spinner.stop();
        spinnerSlot.remove(spinner);
      }

      if (result.display === "inline_transcript") {
        openTuiSink.nextGroup();
        openTuiSink.appendUser(input);
        if (result.shellRun) {
          openTuiSink.appendShellRun(result.shellRun);
        } else if (result.lines.length > 0) {
          openTuiSink.onSystemLines(result.lines);
        }
      } else if (result.display === "toast" && result.toastTone) {
        toast.show(
          result.lines.join(" "),
          toastToneToType(result.toastTone),
        );
      } else if (result.lines.length > 0) {
        openTuiSink.onSlashCommandResult?.(result.lines);
      }

      if (result.action === "exit") {
        await doShutdown();
        return;
      }
      if (result.action === "clear_transcript") {
        projection.apply({ type: "transcript_cleared" });
        transcript.clear();
        openTuiSink?.clearContextPreview();
        refreshChrome();
      }
      if (result.action === "new_session") {
        const newInfo = await controller.startNewSession();
        config = controller.config;
        session = controller.session;

        projection.apply({ type: "transcript_cleared" });
        transcript.clear();
        openTuiSink?.clearContextPreview();

        identityBar.setBackgroundZones(config.ui.background_zones);
        glanceBar.setBackgroundZones(config.ui.background_zones);
        transcriptOpts.markdownRendering = config.ui.markdown_rendering;
        transcriptOpts.syntaxTheme = config.ui.syntax_theme;
        transcriptOpts.backgroundZones = config.ui.background_zones;
        transcriptOpts.useUnicode = config.ui.tool_icons === "unicode";
        projection.setUseUnicode(transcriptOpts.useUnicode);

        openTuiSink.onSystemLines(newInfo.bannerLines);
        openTuiSink.nextGroup();

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
      if (result.action === "open_logout_wizard") {
        openLogoutWizard();
        return;
      }
      renderer.requestRender();
      return;
    }

    openTuiSink.nextGroup();
    openTuiSink.appendUser(input);
    spinnerSlot.add(spinner);
    spinner.setMessage("thinking…");
    turnStartedAt = Date.now();

    try {
      await controller.runUserTurn(input, openTuiSink);
    } finally {
      spinner.stop();
      spinnerSlot.remove(spinner);
      openTuiSink.appendTurnFooter(Date.now() - turnStartedAt);
      refreshChrome();
      renderer.requestRender();
    }
  };

  // Key event handling via the renderer's keypress handler
  renderer.on("keypress", (key: KeyEvent) => {
    if (slashOverlayHandle) {
      dismissSlashCommandResult(renderer, slashOverlayHandle);
      slashOverlayHandle = null;
      return;
    }

    if (matchesKey(key, "f9")) {
      transcript.focus();
      transcript.setFocused(true);
      return;
    }

    if (matchesKey(key, "ctrl+c")) {
      const action = controller.handleUserInterrupt(
        editor.getText().length === 0,
      );
      if (action === "abort_turn") {
        spinner.stop();
        spinnerSlot.remove(spinner);
        openTuiSink.onFallback("⚡ turn aborted");
        renderer.requestRender();
        return;
      }
      if (action === "clear_input") {
        editor.setText("");
        renderer.requestRender();
        return;
      }
      if (action === "exit") {
        void doShutdown();
        return;
      }
    }
  });

  async function doShutdown(): Promise<void> {
    renderer.destroy();
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
}
