/**
 * OpenTUI + Solid entry — ambient intelligence layout (design §5).
 *
 * Solid owns App shell, Prompt, chrome, toast, spinner, transcript, and overlays.
 */
import {
  createCliRenderer,
  ConsolePosition,
} from "@opentui/core";
import { render } from "@opentui/solid";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useBindings } from "@opentui/keymap/solid";
import type { JSX } from "solid-js";
import type { AppController, StartupInfo } from "../../app-controller.js";
import {
  APP_VERSION,
  formatSessionEndEpilogue,
} from "../../app-banner.js";
import { APP_NAME } from "../../app-identity.js";
import { formatLaunchCanvasMeta, formatTuiWelcomeLine } from "./boot-summary.js";
import {
  resolveExpandedContent,
  type TranscriptIndex,
} from "./transcript/index.js";
import type { TranscriptEntry } from "./transcript/model.js";
import { TranscriptProjection } from "./transcript/projection.js";
import { createTranscriptStore } from "./transcript/store.js";
import { OpenTuiSink } from "./sink.js";
import { listAllAvailableModels } from "../../model-listing.js";
import { App } from "./app.js";
import { createShellUi } from "./shell-ui.js";
import { createOverlayUi } from "./overlays/state.js";
import type { PromptHandle } from "./prompt/index.js";
import { DEFAULT_CONTEXT_WINDOW } from "../../status-bar.js";
import type { ContextDisplaySnapshot } from "../../context-display.js";
import type { SlashCommandToastTone } from "../../slash-commands.js";
import type { LoginWizardResult } from "./overlays/login.js";
import type { LogoutWizardResult } from "./overlays/logout.js";

function indexToEntries(index: TranscriptIndex): TranscriptEntry[] {
  return index.groups.flatMap((group) => group.entries);
}

interface GlobalKeyBindingsProps {
  onF9: () => void;
  onCtrlC: () => void;
  onToggleConsole: () => void;
}

function GlobalKeyBindings(props: GlobalKeyBindingsProps): JSX.Element {
  useBindings(() => ({
    bindings: [
      { key: "f9", cmd: () => props.onF9() },
      { key: "ctrl+c", cmd: () => props.onCtrlC() },
      { key: "`", cmd: () => props.onToggleConsole() },
    ],
  }));
  return null as unknown as JSX.Element;
}

function toastToneToType(
  tone: SlashCommandToastTone,
): "error" | "success" | "info" {
  if (tone === "error") return "error";
  if (tone === "success") return "success";
  return "info";
}

export async function runTui(
  controller: AppController,
  info: StartupInfo,
): Promise<void> {
  let config = controller.config;
  let session = controller.session;
  const useUnicode = config.ui.tool_icons === "unicode";

  const welcomeLine = formatTuiWelcomeLine({
    session,
    model: session.getActiveModelLabel(),
    cwd: info.cwd,
    isResume: info.isResume,
    appName: APP_NAME,
    version: APP_VERSION,
  });
  const launchMeta = formatLaunchCanvasMeta({
    session,
    version: APP_VERSION,
  });

  const renderer = await createCliRenderer({
    stdin: process.stdin,
    stdout: process.stdout,
    width: process.stdout.columns ?? 80,
    height: process.stdout.rows ?? 24,
    exitOnCtrlC: false,
    consoleOptions: {
      position: ConsolePosition.BOTTOM,
      sizePercent: 25,
      colorError: "#e06c75",
      colorWarn: "#e5c07b",
      colorInfo: "#56b6c2",
      title: "console",
    },
  });

  const keymap = createDefaultOpenTuiKeymap(renderer);
  // `enabled` is registered for layers/commands by default; add it for
  // individual bindings so the prompt can gate keys (e.g. `up` only when
  // autocomplete is open or the cursor sits on the first row).
  keymap.registerBindingFields({
    enabled(value, ctx) {
      if (value === undefined || value === true) return;
      if (value === false) {
        ctx.activeWhen(() => false);
        return;
      }
      ctx.activeWhen(value as () => boolean);
    },
  });

  const ui = createShellUi();
  ui.toast.attachConsole({
    show() {
      renderer.console.show();
      renderer.requestRender();
    },
  });
  const overlay = createOverlayUi();
  ui.chrome.setBackgroundZones(config.ui.background_zones);
  ui.launch.setMeta(launchMeta);

  const transcriptOpts = {
    markdownRendering: config.ui.markdown_rendering,
    syntaxTheme: config.ui.syntax_theme,
    backgroundZones: config.ui.background_zones,
    useUnicode,
  };
  const projection = new TranscriptProjection({ useUnicode });
  projection.load(indexToEntries(info.transcriptBootstrap ?? { groups: [] }));

  const transcript = createTranscriptStore();
  transcript.loadIndex(info.transcriptBootstrap ?? { groups: [] });

  let prompt: PromptHandle | null = null;
  let openTuiSink: OpenTuiSink | null = null;
  let turnStartedAt = 0;
  let ready = false;

  const refreshChrome = () => {
    const base = controller.getStatusBarInput();
    const preview = openTuiSink?.getContextPreview() ?? null;
    ui.chrome.setStatus(base, {
      showCost: config.ui.show_cost,
      backgroundZones: config.ui.background_zones,
      preview,
    });
  };

  const focusPrompt = () => {
    prompt?.focus();
    renderer.requestRender();
  };

  const dismissOverlay = () => {
    overlay.dismiss();
    focusPrompt();
  };

  const handleSlashTrigger = () => {
    overlay.showPalette();
    renderer.requestRender();
  };

  const handlePaletteRun = (command: string) => {
    prompt?.clear();
    dismissOverlay();
    void runSlashCommand(command);
  };

  const handlePaletteInsert = (text: string) => {
    dismissOverlay();
    prompt?.setText(text);
  };

  const handlePaletteHandoff = (text: string) => {
    dismissOverlay();
    prompt?.setText(text);
  };

  const handlePaletteCancel = () => {
    prompt?.clear();
    dismissOverlay();
  };

  const handleModelSelect = (provider: string, modelId: string) => {
    void (async () => {
      dismissOverlay();
      ui.spinner.start("switching model…");

      let switchResult: import("../../slash-commands.js").SlashCommandResult;
      try {
        switchResult = await controller.executeSlashCommand(
          `/model ${provider} ${modelId}`,
        );
      } finally {
        ui.spinner.stop();
      }

      if (switchResult.display === "toast" && switchResult.toastTone) {
        ui.toast.show(
          switchResult.lines.join(" "),
          toastToneToType(switchResult.toastTone),
        );
      } else if (switchResult.lines.length > 0) {
        ui.toast.show(switchResult.lines.join(" "), "info");
      }
      if (switchResult.action === "refresh_status") {
        refreshChrome();
      }
      renderer.requestRender();
    })();
  };

  const handleLoginComplete = (result: LoginWizardResult) => {
    dismissOverlay();

    if (result.shouldSwitch && result.defaultModel) {
      ui.spinner.start("switching model…");
      void (async () => {
        let switchResult: import("../../slash-commands.js").SlashCommandResult;
        try {
          switchResult = await controller.executeSlashCommand(
            `/model ${result.provider} ${result.defaultModel}`,
          );
        } finally {
          ui.spinner.stop();
        }

        if (switchResult.display === "toast" && switchResult.toastTone) {
          ui.toast.show(
            switchResult.lines.join(" "),
            toastToneToType(switchResult.toastTone),
          );
        } else if (switchResult.lines.length > 0) {
          ui.toast.show(switchResult.lines.join(" "), "info");
        }
        if (switchResult.action === "refresh_status") {
          refreshChrome();
        }
        renderer.requestRender();
      })();
    } else if (result.shouldSwitch) {
      session.setProviderOverride(result.provider);
      ui.toast.show(result.message, "success");
      refreshChrome();
      renderer.requestRender();
    } else {
      const tone: "info" | "success" =
        result.message.includes("Run /new") ? "info" : "success";
      ui.toast.show(result.message, tone);
      refreshChrome();
      renderer.requestRender();
    }
  };

  const handleLogoutComplete = (result: LogoutWizardResult) => {
    dismissOverlay();
    const tone: "info" | "success" =
      result.message.includes("Run /new") ? "info" : "success";
    ui.toast.show(result.message, tone);
    refreshChrome();
    renderer.requestRender();
  };

  async function doShutdown(): Promise<void> {
    transcript.dispose();
    overlay.dispose();
    ui.dispose();
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

  const runSlashCommand = async (input: string) => {
    if (!openTuiSink) return;
    ui.spinner.start("running command…");

    let result: import("../../slash-commands.js").SlashCommandResult;
    try {
      result = await controller.executeSlashCommand(input);
    } finally {
      ui.spinner.stop();
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
      ui.toast.show(
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
      ui.launch.setMeta(formatLaunchCanvasMeta({ session, version: APP_VERSION }));
      refreshChrome();
    }
    if (result.action === "new_session") {
      await controller.startNewSession();
      config = controller.config;
      session = controller.session;

      projection.apply({ type: "transcript_cleared" });
      transcript.clear();
      openTuiSink.clearContextPreview();

      ui.chrome.setBackgroundZones(config.ui.background_zones);
      transcriptOpts.markdownRendering = config.ui.markdown_rendering;
      transcriptOpts.syntaxTheme = config.ui.syntax_theme;
      transcriptOpts.backgroundZones = config.ui.background_zones;
      transcriptOpts.useUnicode = config.ui.tool_icons === "unicode";
      projection.setUseUnicode(transcriptOpts.useUnicode);

      ui.launch.setMeta(
        formatLaunchCanvasMeta({ session, version: APP_VERSION }),
      );

      refreshChrome();
    }
    if (result.action === "refresh_status") {
      refreshChrome();
    }
    if (result.action === "open_model_selector") {
      overlay.showModel();
      renderer.requestRender();
      return;
    }
    if (result.action === "open_login_wizard") {
      overlay.showLogin(result.loginProviderHint);
      renderer.requestRender();
      return;
    }
    if (result.action === "open_logout_wizard") {
      overlay.showLogout();
      renderer.requestRender();
      return;
    }
    renderer.requestRender();
  };

  const handleSubmit = async (rawInput: string) => {
    if (!openTuiSink || !ready) return;
    let input = rawInput.trim();
    if (!input) return;
    ui.toast.clearErrors();

    if (input.startsWith("!")) {
      const command = input.slice(1).trim();
      if (!command) {
        ui.toast.show("Usage: !<command>", "error");
        return;
      }
      input = `/shell ${command}`;
    }

    if (input.startsWith("/")) {
      await runSlashCommand(input);
      return;
    }

    openTuiSink.nextGroup();
    openTuiSink.appendUser(input);
    ui.spinner.start("thinking…");
    turnStartedAt = Date.now();

    try {
      await controller.runUserTurn(input, openTuiSink);
    } finally {
      ui.spinner.stop();
      openTuiSink.appendTurnFooter(Date.now() - turnStartedAt);
      refreshChrome();
      renderer.requestRender();
    }
  };

  await render(
    () => (
      <KeymapProvider keymap={keymap}>
        <GlobalKeyBindings
          onF9={() => {
            transcript.setFocused(true);
            // Blur the prompt so its focus-scoped keymap layer deactivates and
            // the transcript's navigation bindings own up/down/etc.
            prompt?.blur();
            renderer.requestRender();
          }}
          onToggleConsole={() => {
            renderer.console.toggle();
            renderer.requestRender();
          }}
          onCtrlC={() => {
            const action = controller.handleUserInterrupt(
              (prompt?.getText().length ?? 0) === 0,
            );
            if (action === "abort_turn") {
              ui.spinner.stop();
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
          }}
        />
        <App
          cwd={info.cwd}
          ui={ui}
          overlay={overlay}
          transcript={transcript}
          transcriptOpts={transcriptOpts}
          currentProvider={() => session.getEffectiveProvider()}
          currentModelId={() => session.getActiveModelId()}
          loadModels={() => listAllAvailableModels()}
          onModelSelect={handleModelSelect}
          onLoginComplete={handleLoginComplete}
          onLogoutComplete={handleLogoutComplete}
          onOverlayDismiss={dismissOverlay}
          onSlashTrigger={handleSlashTrigger}
          onPaletteRun={handlePaletteRun}
          onPaletteInsert={handlePaletteInsert}
          onPaletteHandoff={handlePaletteHandoff}
          onPaletteCancel={handlePaletteCancel}
          onExpand={(entry) =>
            Promise.resolve(
              resolveExpandedContent(entry, session.eventLog.readAll()),
            )
          }
          onSubmit={handleSubmit}
          onReady={({ prompt: promptApi }) => {
          prompt = promptApi;
          ready = true;

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

          openTuiSink = new OpenTuiSink(transcript.mount, ui.toast, {
            ambient: config.ui.ambient,
            showThinking: () => controller.showThinking,
            onSpinnerMessage: (msg: string) => {
              ui.spinner.setMessage(msg);
            },
            ctxWindowTokens: ctxWindow,
            engineMode: session.isContextEngineEnabled(),
            projection,
            persistEntry: persistTranscriptEntry,
            getModel: () => controller.currentModelOrDefault(),
            onSlashCommandResult: (lines: string[]) => {
              overlay.showSlash(lines);
              renderer.requestRender();
            },
            onContextPreview: (snapshot: ContextDisplaySnapshot) => {
              ui.chrome.setStatus(controller.getStatusBarInput(), {
                showCost: config.ui.show_cost,
                backgroundZones: config.ui.background_zones,
                preview: snapshot,
              });
            },
          });

          // Resume-only transcript notice; fresh idle uses LaunchCanvas.
          if (welcomeLine) {
            openTuiSink.onSystemLines([welcomeLine]);
            openTuiSink.nextGroup();
          }

          refreshChrome();
          prompt.focus();
          renderer.requestRender();
        }}
        />
      </KeymapProvider>
    ),
    renderer,
  );
}
