/**
 * OpenTUI + Solid entry — ambient intelligence layout (design §5).
 *
 * Solid owns App shell, Prompt, chrome, toast, spinner, transcript, and overlays.
 */
import {
  createCliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { render } from "@opentui/solid";
import type { AppController, StartupInfo } from "../../app-controller.js";
import {
  APP_VERSION,
  formatSessionEndEpilogue,
} from "../../app-banner.js";
import { formatTuiBootSummary } from "./boot-summary.js";
import {
  resolveExpandedContent,
  type TranscriptIndex,
} from "./transcript/index.js";
import type { TranscriptEntry } from "./transcript/model.js";
import { TranscriptProjection } from "./transcript/projection.js";
import { createTranscriptStore } from "./transcript/store.js";
import { OpenTuiSink } from "./sink.js";
import { listAllAvailableModels } from "../../model-listing.js";
import { renderBootBanner } from "./banner.js";
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

  const ui = createShellUi();
  const overlay = createOverlayUi();
  ui.chrome.setBackgroundZones(config.ui.background_zones);

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
        refreshChrome();
      }
      if (result.action === "new_session") {
        const newInfo = await controller.startNewSession();
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

        openTuiSink.onSystemLines(newInfo.bannerLines);
        openTuiSink.nextGroup();

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

          refreshChrome();
          prompt.focus();
          renderer.requestRender();
        }}
      />
    ),
    renderer,
  );

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (matchesKey(key, "f9")) {
      transcript.setFocused(true);
      renderer.requestRender();
      return;
    }

    if (matchesKey(key, "ctrl+c")) {
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
    }
  });
}
