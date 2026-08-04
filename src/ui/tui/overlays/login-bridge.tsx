/**
 * Temporary bridge: mounts imperative LoginWizard into a Solid Portal host.
 * Full Solid login rewrite is deferred (large multi-step wizard).
 */
import { onCleanup, onMount } from "solid-js";
import { useRenderer } from "@opentui/solid";
import type { BoxRenderable } from "@opentui/core";
import { LoginWizard, type LoginWizardResult } from "../login-wizard.js";
import { OverlayFrame } from "./frame.js";

export interface LoginBridgeProps {
  currentProvider: string;
  initialProvider?: string;
  onComplete: (result: LoginWizardResult) => void;
  onCancel: () => void;
}

export function LoginBridge(props: LoginBridgeProps) {
  const renderer = useRenderer();
  let host: BoxRenderable | undefined;
  let wizard: LoginWizard | undefined;

  onMount(() => {
    queueMicrotask(() => {
      if (!host) return;
      wizard = new LoginWizard(renderer, undefined, {
        currentProvider: props.currentProvider,
        initialProvider: props.initialProvider,
        onComplete: props.onComplete,
        onCancel: props.onCancel,
      });
      host.add(wizard);
      wizard.focus();
      renderer.requestRender();
    });
  });

  onCleanup(() => {
    if (wizard && host) {
      try {
        host.remove(wizard);
      } catch {
        /* already removed */
      }
    }
    wizard = undefined;
  });

  return (
    <OverlayFrame width={56}>
      <box
        id="login-bridge-host"
        ref={(el: BoxRenderable) => {
          host = el;
        }}
        flexDirection="column"
      />
    </OverlayFrame>
  );
}
