/**
 * In-session overlay switchboard.
 */
import { Show, createEffect, createMemo, onCleanup } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import type { ModelListEntry } from "../../../model-listing.js";
import type { OverlayUi } from "./state.js";
import { SlashResultOverlay } from "./slash-result.js";
import { ModelSelectorOverlay } from "./model-selector.js";
import { LogoutOverlay } from "./logout.js";
import { LoginBridge } from "./login-bridge.js";
import type { LoginWizardResult } from "../login-wizard.js";
import type { LogoutWizardResult } from "../logout-wizard.js";

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
  const kind = createMemo(() => props.overlay.kind());

  createEffect(() => {
    if (kind() !== "slash") return;
    let armed = false;
    const armTimer = setTimeout(() => {
      armed = true;
    }, 100);
    const onKey = (key: KeyEvent) => {
      if (!armed) return;
      key.preventDefault();
      props.onDismiss();
    };
    renderer.keyInput.on("keypress", onKey);
    onCleanup(() => {
      clearTimeout(armTimer);
      renderer.keyInput.off("keypress", onKey);
    });
  });

  createEffect(() => {
    const k = kind();
    if (k !== "model" && k !== "logout") return;
    const onKey = (key: KeyEvent) => {
      if (key.name === "escape") props.onDismiss();
    };
    renderer.keyInput.on("keypress", onKey);
    onCleanup(() => {
      renderer.keyInput.off("keypress", onKey);
    });
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
          <LoginBridge
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
