/**
 * In-session overlay switchboard.
 */
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { useBindings, useKeymap } from "@opentui/keymap/solid";
import type { ModelListEntry } from "../../../model-listing.js";
import type { OverlayUi } from "./state.js";
import { SlashResultOverlay } from "./slash-result.js";
import { ModelSelectorOverlay } from "./model-selector.js";
import { LogoutOverlay } from "./logout.js";
import { LoginOverlay, type LoginWizardResult } from "./login.js";
import type { LogoutWizardResult } from "./logout.js";

export interface OverlayHostProps {
  overlay: OverlayUi;
  currentProvider: () => string;
  currentModelId: () => string;
  loadModels: () => Promise<ModelListEntry[]>;
  onModelSelect: (provider: string, modelId: string) => void;
  onLoginComplete: (result: LoginWizardResult) => void;
  onLogoutComplete: (result: LogoutWizardResult) => void;
  onDismiss: () => void;
}

export function OverlayHost(props: OverlayHostProps) {
  const renderer = useRenderer();
  const keymap = useKeymap();
  const kind = createMemo(() => props.overlay.kind());
  const [slashArmed, setSlashArmed] = createSignal(false);

  createEffect(() => {
    if (kind() !== "slash") {
      setSlashArmed(false);
      return;
    }
    const armTimer = setTimeout(() => setSlashArmed(true), 100);
    onCleanup(() => clearTimeout(armTimer));
  });

  // The slash result overlay dismisses on ANY keypress (after the arm delay);
  // a key intercept is the idiomatic "any key" hook.
  createEffect(() => {
    if (kind() !== "slash" || !slashArmed()) return;
    const off = keymap.intercept("key", (ctx) => {
      ctx.consume({ preventDefault: true, stopPropagation: true });
      props.onDismiss();
    });
    onCleanup(off);
  });

  useBindings(() => {
    const k = kind();
    if (k === "model" || k === "login" || k === "logout") {
      return {
        bindings: [{ key: "escape", cmd: () => props.onDismiss() }],
      };
    }
    return { bindings: [] };
  });

  createEffect(() => {
    void kind();
    renderer.requestRender();
  });

  return (
    <Show when={kind() !== "none"}>
      <box
        id="overlay-host"
        position="absolute"
        zIndex={OVERLAY_Z}
        left={0}
        top={0}
        width="100%"
        height="100%"
      >
        <Show when={kind() === "slash"}>
          <SlashResultOverlay lines={props.overlay.slashLines()} />
        </Show>
        <Show when={kind() === "model"}>
          <ModelSelectorOverlay
            currentProvider={props.currentProvider()}
            currentModelId={props.currentModelId()}
            loadModels={props.loadModels}
            onSelect={props.onModelSelect}
            onCancel={props.onDismiss}
          />
        </Show>
        <Show when={kind() === "login"}>
          <LoginOverlay
            currentProvider={props.currentProvider()}
            initialProvider={props.overlay.loginHint()}
            onComplete={props.onLoginComplete}
            onCancel={props.onDismiss}
          />
        </Show>
        <Show when={kind() === "logout"}>
          <LogoutOverlay
            currentProvider={props.currentProvider()}
            onComplete={props.onLogoutComplete}
            onCancel={props.onDismiss}
          />
        </Show>
      </box>
    </Show>
  );
}

const OVERLAY_Z = 999;
