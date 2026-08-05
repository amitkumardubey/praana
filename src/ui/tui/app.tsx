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
import { TranscriptView } from "./transcript/view.js";
import { OverlayHost } from "./overlays/host.js";
import type { OverlayUi } from "./overlays/state.js";
import type { TranscriptStoreApi } from "./transcript/store.js";
import type { TranscriptRenderOpts } from "./transcript/opts.js";
import type { ExpandedContentResult, IndexedTranscriptEntry } from "./transcript/index.js";
import type { ShellUi } from "./shell-ui.js";
import type { ModelListEntry } from "../../model-listing.js";
import type { LoginWizardResult } from "./overlays/login.js";
import type { LogoutWizardResult } from "./overlays/logout.js";

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
  loadModels: () => Promise<ModelListEntry[]>;
  onModelSelect: (provider: string, modelId: string) => void;
  onLoginComplete: (result: LoginWizardResult) => void;
  onLogoutComplete: (result: LogoutWizardResult) => void;
  onOverlayDismiss: () => void;
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

  const showLaunch = createMemo(() => props.transcript.entries.length === 0);

  return (
    <box id="tui-root" flexDirection="column" width="100%" height="100%">
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
        onDismiss={props.onOverlayDismiss}
      />
    </box>
  );
}
