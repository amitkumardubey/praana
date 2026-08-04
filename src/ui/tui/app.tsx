/**
 * Solid TUI application root.
 *
 * Transcript / wizards still attach into `body` during later phases.
 * Prompt, chrome, toast, and spinner are Solid.
 */
import { createEffect, onMount } from "solid-js";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import type { BoxRenderable } from "@opentui/core";
import { Prompt, type PromptHandle } from "./prompt/index.js";
import { IdentityBar, GlanceBar } from "./chrome/bars.js";
import { ToastHost } from "./toast-host.js";
import { SpinnerHost } from "./spinner-host.js";
import type { ShellUi } from "./shell-ui.js";

export interface AppReady {
  body: BoxRenderable;
  prompt: PromptHandle;
}

export interface AppProps {
  cwd: string;
  ui: ShellUi;
  onSubmit: (text: string) => void | Promise<void>;
  onReady: (api: AppReady) => void;
}

export function App(props: AppProps) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  let body!: BoxRenderable;
  let promptApi: PromptHandle | undefined;
  let readySent = false;

  const tryReady = () => {
    if (readySent || !body || !promptApi) return;
    readySent = true;
    props.onReady({ body, prompt: promptApi });
    promptApi.focus();
    renderer.requestRender();
  };

  onMount(() => {
    queueMicrotask(tryReady);
  });

  createEffect(() => {
    props.ui.chrome.setWidth(dimensions().width || 80);
  });

  return (
    <box id="tui-root" flexDirection="column" width="100%" height="100%">
      <box
        id="body"
        ref={(el: BoxRenderable) => {
          body = el;
        }}
        flexGrow={1}
        flexDirection="column"
        minHeight={1}
      />

      <ToastHost toasts={props.ui.toasts} />
      <SpinnerHost active={props.ui.spinner.active} message={props.ui.spinner.message} />

      <Prompt
        cwd={props.cwd}
        focused
        ref={(api) => {
          promptApi = api;
          tryReady();
        }}
        onSubmit={props.onSubmit}
      />

      <box id="chrome" flexDirection="column" flexShrink={0}>
        <IdentityBar line={props.ui.chrome.identityLine} />
        <GlanceBar line={props.ui.chrome.glanceLine} />
      </box>
    </box>
  );
}
