/**
 * OpenTUI + Solid entry — ambient intelligence layout (design §5).
 *
 * Solid owns the app shell and Prompt; transcript/toasts/wizards attach into
 * host boxes during the migration.
 */
import {
  createCliRenderer,
  BoxRenderable,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core";
import { render } from "@opentui/solid";
import type { AppController, StartupInfo } from "../../app-controller.js";
import {
  APP_VERSION,
  formatSessionEndEpilogue,
} from "../../app-banner.js";
import { formatTuiBootSummary } from "./boot-summary.js";
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
import { Spinner } from "./spinner.js";
import { App } from "./app.js";
import type { PromptHandle } from "./prompt/index.js";
import { DEFAULT_CONTEXT_WINDOW, type StatusBarInput } from "../../status-bar.js";
import type { ContextDisplaySnapshot } from "../../context-display.js";
import type { SlashCommandToastTone } from "../../slash-commands.js";

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

  const transcriptOpts = {
    markdownRendering: config.ui.markdown_rendering,
    syntaxTheme: config.ui.syntax_theme,
    backgroundZones: config.ui.background_zones,
    useUnicode,
  };
  const projection = new TranscriptProjection({ useUnicode });
  projection.load(indexToEntries(info.transcriptBootstrap ?? { groups: [] }));

  let prompt: PromptHandle | null = null;
  let openTuiSink: OpenTuiSink | null = null;
  let slashOverlayHandle: import("./overlay.js").OverlayHandle | null = null;
  let turnStartedAt = 0;

  // Hosts filled in App.onReady
  let overlaySlot: BoxRenderable | null = null;
  let spinnerSlot: BoxRenderable | null = null;
  let transcript: TranscriptContainer | null = null;
  let toast: ToastRegion | null = null;
  let spinner: Spinner | null = null;
  let identityBar: IdentityBar | null = null;
  let glanceBar: GlanceBar | null = null;

  const clearSlot = (slot: BoxRenderable) => {
    for (const child of slot.getChildren()) {
      slot.remove(child);
    }
  };

  const refreshChrome = () => {
    if (!identityBar || !glanceBar) return;
    const base = controller.getStatusBarInput();
    const preview = openTuiSink?.getContextPreview() ?? null;
    identityBar.setInput(base);
    glanceBar.update({
      status: preview ? statusBarFromSnapshot(base, preview) : base,
      showCost: config.ui.show_cost,
    });
  };

  const focusPrompt = () => {
    prompt?.focus();
    renderer.requestRender();
  };

  const closeOverlay = () => {
    if (!overlaySlot) return;
    clearSlot(overlaySlot);
    focusPrompt();
  };

  const openModelSelector = () => {
    if (!overlaySlot || !spinnerSlot || !toast || !spinner) return;
    if (slashOverlayHandle) {
      dismissSlashCommandResult(renderer, slashOverlayHandle);
      slashOverlayHandle = null;
    }

    const selector = new ModelSelector(ctx, {
      currentProvider: session.getEffectiveProvider(),
      currentModelId: session.getActiveModelId(),
      maxVisible: Math.max(6, Math.min(12, (process.stdout.rows ?? 24) - 14)),
      loadModels: () => listAllAvailableModels(),
      onCancel: () => closeOverlay(),
      onSelect: (provider: string, modelId: string) => {
        void (async () => {
          closeOverlay();
          spinnerSlot!.add(spinner!);
          spinner!.setMessage("switching model…");

          let switchResult: import("../../slash-commands.js").SlashCommandResult;
          try {
            switchResult = await controller.executeSlashCommand(
              `/model ${provider} ${modelId}`,
            );
          } finally {
            spinner!.stop();
            spinnerSlot!.remove(spinner!);
          }

          if (switchResult.display === "toast" && switchResult.toastTone) {
            toast!.show(
              switchResult.lines.join(" "),
              toastToneToType(switchResult.toastTone),
            );
          } else if (switchResult.lines.length > 0) {
            toast!.show(switchResult.lines.join(" "), "info");
          }
          if (switchResult.action === "refresh_status") {
            refreshChrome();
          }
          renderer.requestRender();
        })();
      },
    });

    clearSlot(overlaySlot);
    overlaySlot.add(selector);
    selector.focus();
    renderer.requestRender();
  };

  const openLoginWizard = (providerHint?: string) => {
    if (!overlaySlot || !spinnerSlot || !toast || !spinner) return;
    if (slashOverlayHandle) {
      dismissSlashCommandResult(renderer, slashOverlayHandle);
      slashOverlayHandle = null;
    }

    const wizard = new LoginWizard(ctx, undefined, {
      currentProvider: session.getEffectiveProvider(),
      initialProvider: providerHint,
      onComplete: (result: import("./login-wizard.js").LoginWizardResult) => {
        closeOverlay();

        if (result.shouldSwitch && result.defaultModel) {
          spinnerSlot!.add(spinner!);
          spinner!.setMessage("switching model…");

          void (async () => {
            let switchResult: import("../../slash-commands.js").SlashCommandResult;
            try {
              switchResult = await controller.executeSlashCommand(
                `/model ${result.provider} ${result.defaultModel}`,
              );
            } finally {
              spinner!.stop();
              spinnerSlot!.remove(spinner!);
            }

            if (switchResult.display === "toast" && switchResult.toastTone) {
              toast!.show(
                switchResult.lines.join(" "),
                toastToneToType(switchResult.toastTone),
              );
            } else if (switchResult.lines.length > 0) {
              toast!.show(switchResult.lines.join(" "), "info");
            }
            if (switchResult.action === "refresh_status") {
              refreshChrome();
            }
            renderer.requestRender();
          })();
        } else if (result.shouldSwitch) {
          session.setProviderOverride(result.provider);
          toast!.show(result.message, "success");
          refreshChrome();
          renderer.requestRender();
        } else {
          const tone: "info" | "success" =
            result.message.includes("Run /new") ? "info" : "success";
          toast!.show(result.message, tone);
          refreshChrome();
          renderer.requestRender();
        }
      },
      onCancel: () => closeOverlay(),
    });

    clearSlot(overlaySlot);
    overlaySlot.add(wizard);
    wizard.focus();
    renderer.requestRender();
  };

  const openLogoutWizard = () => {
    if (!overlaySlot || !toast) return;
    if (slashOverlayHandle) {
      dismissSlashCommandResult(renderer, slashOverlayHandle);
      slashOverlayHandle = null;
    }

    const wizard = new LogoutWizard(ctx, [], {
      currentProvider: session.getEffectiveProvider(),
      onComplete: (result: import("./logout-wizard.js").LogoutWizardResult) => {
        closeOverlay();
        const tone: "info" | "success" =
          result.message.includes("Run /new") ? "info" : "success";
        toast!.show(result.message, tone);
        refreshChrome();
        renderer.requestRender();
      },
      onCancel: () => closeOverlay(),
    });

    clearSlot(overlaySlot);
    overlaySlot.add(wizard);
    wizard.focus();
    renderer.requestRender();
  };

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

  const handleSubmit = async (rawInput: string) => {
    if (!openTuiSink || !toast || !spinner || !spinnerSlot || !transcript) return;
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
        openTuiSink.clearContextPreview();
        refreshChrome();
      }
      if (result.action === "new_session") {
        const newInfo = await controller.startNewSession();
        config = controller.config;
        session = controller.session;

        projection.apply({ type: "transcript_cleared" });
        transcript.clear();
        openTuiSink.clearContextPreview();

        identityBar?.setBackgroundZones(config.ui.background_zones);
        glanceBar?.setBackgroundZones(config.ui.background_zones);
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

  await render(
    () => (
      <App
        cwd={info.cwd}
        onSubmit={handleSubmit}
        onReady={({ body, chrome, prompt: promptApi }) => {
          prompt = promptApi;

          transcript = new TranscriptContainer(
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
                else prompt?.focus();
              },
            },
          );
          transcript.loadIndex(info.transcriptBootstrap ?? { groups: [] });

          toast = new ToastRegion(ctx);
          spinner = new Spinner(ctx, "thinking…");
          spinnerSlot = new BoxRenderable(ctx, { id: "spinner-slot", flexDirection: "column" });
          overlaySlot = new BoxRenderable(ctx, { id: "overlay-slot", flexDirection: "column" });

          body.add(transcript);
          body.add(toast);
          body.add(spinnerSlot);
          body.add(overlaySlot);

          identityBar = new IdentityBar(ctx);
          identityBar.setBackgroundZones(config.ui.background_zones);
          identityBar.setInput(controller.getStatusBarInput());

          glanceBar = new GlanceBar(ctx);
          glanceBar.setBackgroundZones(config.ui.background_zones);

          chrome.add(identityBar);
          chrome.add(glanceBar);

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

          openTuiSink = new OpenTuiSink(ctx, transcript, toast, {
            ambient: config.ui.ambient,
            showThinking: () => controller.showThinking,
            onSpinnerMessage: (msg: string) => {
              spinner?.setMessage(msg);
            },
            ctxWindowTokens: ctxWindow,
            engineMode: session.isContextEngineEnabled(),
            projection,
            persistEntry: persistTranscriptEntry,
            getModel: () => controller.currentModelOrDefault(),
            onSlashCommandResult: showSlashOverlay,
            onContextPreview: (snapshot: ContextDisplaySnapshot) => {
              glanceBar?.update({
                status: statusBarFromSnapshot(controller.getStatusBarInput(), snapshot),
                showCost: config.ui.show_cost,
              });
            },
          });

          refreshChrome();
          prompt.focus();
          renderer.requestRender();
        }}
      />
    ),
    renderer,
  );

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (slashOverlayHandle) {
      dismissSlashCommandResult(renderer, slashOverlayHandle);
      slashOverlayHandle = null;
      return;
    }

    if (matchesKey(key, "f9") && transcript) {
      transcript.focus();
      transcript.setFocused(true);
      return;
    }

    if (matchesKey(key, "ctrl+c")) {
      const action = controller.handleUserInterrupt(
        (prompt?.getText().length ?? 0) === 0,
      );
      if (action === "abort_turn") {
        spinner?.stop();
        if (spinner && spinnerSlot) spinnerSlot.remove(spinner);
        openTuiSink?.onFallback("⚡ turn aborted");
        renderer.requestRender();
        return;
      }
      if (action === "clear_input") {
        prompt?.clear();
        renderer.requestRender();
        return;
      }
      if (action === "exit") {
        void doShutdown();
        return;
      }
    }
  });
}
