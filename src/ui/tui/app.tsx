/**
 * Solid TUI application root.
 *
 * Solid owns Prompt, chrome, toast, spinner, transcript, and overlays.
 */
import { Show, createEffect, createMemo, onMount } from "solid-js";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { Prompt, type PromptHandle } from "./prompt/index.js";
import { IdentityBar, GlanceBar } from "./chrome/bars.js";
import { ToastHost } from "./toast-host.js";
import { SpinnerHost } from "./spinner-host.js";
import { LaunchCanvas } from "./launch-canvas.js";
import { TranscriptView, shouldRestorePromptFocus } from "./transcript/view.js";
import { OverlayHost } from "./overlays/host.js";
import { launchCanvasHiddenForOverlay, type OverlayUi } from "./overlays/state.js";
import type { TranscriptStoreApi } from "./transcript/store.js";
import type { TranscriptRenderOpts } from "./transcript/opts.js";
import type { ExpandedContentResult, IndexedTranscriptEntry } from "./transcript/index.js";
import type { ShellUi } from "./shell-ui.js";
import type { ListAllAvailableModelsOptions, ModelListEntry } from "../../model-listing.js";
import type { LoginWizardResult } from "./overlays/login.js";
import type { LogoutWizardResult } from "./overlays/logout.js";
import type { SetupResult } from "../../setup/types.js";
import type { Session } from "../../session.js";

export interface AppReady {
  prompt: PromptHandle;
}

export interface AppProps {
  cwd: string;
  ui: ShellUi;
  overlay: OverlayUi;
  transcript: TranscriptStoreApi;
  transcriptOpts: TranscriptRenderOpts;
  currentProvider: () => string;
  currentModelId: () => string;
  loadModels: (opts?: ListAllAvailableModelsOptions) => Promise<ModelListEntry[]>;
  onModelSelect: (provider: string, modelId: string) => void;
  onLoginComplete: (result: LoginWizardResult) => void;
  onLogoutComplete: (result: LogoutWizardResult) => void;
  onSetupComplete: (result: SetupResult) => void;
  onConsentComplete: (proceed: boolean) => void;
  logoutSession: () => Session;
  configProvider: () => string;
  configModel: () => string;
  onPaletteRun: (command: string) => void;
  onPaletteInsert: (text: string) => void;
  onPaletteHandoff: (text: string) => void;
  onPaletteCancel: () => void;
  onOverlayDismiss: () => void;
  onSlashTrigger: () => void;
  onExpand?: (
    entry: IndexedTranscriptEntry,
  ) => Promise<ExpandedContentResult> | ExpandedContentResult;
  onSubmit: (text: string) => void | Promise<void>;
  onReady: (api: AppReady) => void;
}

export function App(props: AppProps) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  let promptApi: PromptHandle | undefined;
  let readySent = false;

  const tryReady = () => {
    if (readySent || !promptApi) return;
    readySent = true;
    props.onReady({ prompt: promptApi });
    promptApi.focus();
    renderer.requestRender();
  };

  onMount(() => {
    queueMicrotask(tryReady);
  });

  createEffect(() => {
    props.ui.chrome.setWidth(dimensions().width || 80);
  });

  // Launch canvas (and its first-screen hint) only while the transcript is
  // empty AND no full-screen modal (setup wizard, consent, login) is open.
  // Transient overlays (palette / slash / model) keep the canvas visible so
  // the logo does not vanish and flicker back on every keystroke.
  const showLaunch = createMemo(
    () =>
      props.transcript.entries.length === 0 &&
      !launchCanvasHiddenForOverlay(props.overlay.kind()),
  );

  /**
   * Safety net for the prompt focus papercut: OpenTUI auto-focuses the nearest
   * focusable renderable under the pointer on mouse-down. The transcript opts
   * out of being focusable, but a future focusable renderable (or a scrollbar)
   * must not be able to leave typing dead — if a mouse interaction ends with no
   * text editor focused, hand focus back to the prompt. An active selection is
   * renderer-owned, so it survives this refocus until the next key press.
   */
  const handleMouseUp = () => {
    const restore = shouldRestorePromptFocus({
      overlayOpen: props.overlay.kind() !== "none",
      transcriptFocusMode: props.transcript.focusMode(),
      editorFocused: renderer.currentFocusedEditor !== null,
    });
    if (!restore) return;
    promptApi?.focus();
  };

  return (
    <box
      id="tui-root"
      flexDirection="column"
      width="100%"
      height="100%"
      onMouseUp={handleMouseUp}
    >
      <box id="body" flexGrow={1} flexDirection="column" minHeight={1}>
        <Show
          when={showLaunch()}
          fallback={
            <TranscriptView
              store={props.transcript}
              opts={props.transcriptOpts}
              onExpand={props.onExpand}
              onRequestFocus={() => promptApi?.focus()}
            />
          }
        >
          <LaunchCanvas
            version={props.ui.launch.version}
            skillsLabel={props.ui.launch.skillsLabel}
          />
        </Show>
      </box>

      <ToastHost toasts={props.ui.toasts} />
      <SpinnerHost active={props.ui.spinner.active} message={props.ui.spinner.message} />

      <Prompt
        cwd={props.cwd}
        focused
        placeholder="message praana"
        onSlashTrigger={props.onSlashTrigger}
        ref={(api) => {
          promptApi = api;
          tryReady();
        }}
        onSubmit={props.onSubmit}
      />

      <box id="chrome" flexDirection="column" flexShrink={0} marginTop={1}>
        <IdentityBar segments={props.ui.chrome.identitySegments} />
        <box height={1} flexShrink={0} />
        <GlanceBar
          metrics={props.ui.chrome.glanceMetrics}
          flags={props.ui.chrome.glanceFlags}
        />
      </box>

      <OverlayHost
        overlay={props.overlay}
        currentProvider={props.currentProvider}
        currentModelId={props.currentModelId}
        loadModels={props.loadModels}
        onModelSelect={props.onModelSelect}
        onLoginComplete={props.onLoginComplete}
        onLogoutComplete={props.onLogoutComplete}
        onSetupComplete={props.onSetupComplete}
        onConsentComplete={props.onConsentComplete}
        logoutSession={props.logoutSession}
        configProvider={props.configProvider}
        configModel={props.configModel}
        onPaletteRun={props.onPaletteRun}
        onPaletteInsert={props.onPaletteInsert}
        onPaletteHandoff={props.onPaletteHandoff}
        onPaletteCancel={props.onPaletteCancel}
        onDismiss={props.onOverlayDismiss}
      />
    </box>
  );
}
