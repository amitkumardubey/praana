/**
 * Solid TUI application root.
 *
 * Transcript / toasts / wizards attach into `body` during migration.
 * Prompt is fully Solid. Chrome bars attach into `chrome`.
 */
import { onMount } from "solid-js";
import { useRenderer } from "@opentui/solid";
import type { BoxRenderable } from "@opentui/core";
import { Prompt, type PromptHandle } from "./prompt/index.js";

export interface AppReady {
  body: BoxRenderable;
  chrome: BoxRenderable;
  prompt: PromptHandle;
}

export interface AppProps {
  cwd: string;
  onSubmit: (text: string) => void | Promise<void>;
  onReady: (api: AppReady) => void;
}

export function App(props: AppProps) {
  const renderer = useRenderer();
  let body!: BoxRenderable;
  let chrome!: BoxRenderable;
  let promptApi: PromptHandle | undefined;
  let readySent = false;

  const tryReady = () => {
    if (readySent || !body || !chrome || !promptApi) return;
    readySent = true;
    props.onReady({ body, chrome, prompt: promptApi });
    promptApi.focus();
    renderer.requestRender();
  };

  onMount(() => {
    queueMicrotask(tryReady);
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

      <Prompt
        cwd={props.cwd}
        focused
        ref={(api) => {
          promptApi = api;
          tryReady();
        }}
        onSubmit={props.onSubmit}
      />

      <box
        id="chrome"
        ref={(el: BoxRenderable) => {
          chrome = el;
        }}
        flexDirection="column"
        flexShrink={0}
      />
    </box>
  );
}
