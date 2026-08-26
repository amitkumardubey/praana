/**
 * Solid logout provider picker.
 */
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { listStoredProviders } from "../../../credentials.js";
import { isUserDeclaredProvider } from "../../../provider-registry.js";
import { logoutProvider } from "../../../setup/logout.js";
import { TUI_STYLE } from "../theme.js";
import { OverlayFrame } from "./frame.js";

export interface LogoutWizardResult {
  provider: string;
  message: string;
  sectionRemoved: boolean;
  isActiveProvider: boolean;
  needsLogin: boolean;
  switchedTo?: { provider: string; model: string };
}

export interface LogoutOverlayProps {
  currentProvider: string;
  session: {
    getEffectiveProvider(): string;
    getActiveModelId?(): string;
    setProviderOverride?(provider: string | null): void;
    setModelOverride?(model: string | null): void;
    config?: {
      llm: { provider: string; model: string };
      providers?: Record<string, unknown>;
    };
  };
  onComplete: (result: LogoutWizardResult) => void;
  onCancel: () => void;
}

function buildOptions(currentProvider: string) {
  return listStoredProviders().map((p) => {
    const tags: string[] = [];
    if (p === currentProvider) tags.push("active");
    if (isUserDeclaredProvider(p)) tags.push("custom");
    const name = tags.length > 0 ? `${p} (${tags.join(", ")})` : p;
    return { name, description: "", value: p };
  });
}

export function LogoutOverlay(props: LogoutOverlayProps) {
  const [options, setOptions] = createSignal(buildOptions(props.currentProvider));
  const height = createMemo(() => Math.max(6, Math.min(12, options().length + 2)));

  onMount(() => {
    setOptions(buildOptions(props.currentProvider));
  });

  const removeProvider = (provider: string) => {
    const outcome = logoutProvider(provider, props.session);
    props.onComplete({
      provider,
      message: outcome.lines.join(" "),
      sectionRemoved: outcome.sectionRemoved,
      isActiveProvider: outcome.isActiveProvider,
      needsLogin: outcome.needsLogin,
      switchedTo: outcome.switchedTo,
    });
  };

  return (
    <OverlayFrame width={48}>
      <text><span style={TUI_STYLE.info}>Logout — select a provider to remove</span></text>
      <Show
        when={options().length > 0}
        fallback={<text><span style={TUI_STYLE.muted}>No stored credentials.</span></text>}
      >
        <select
          focused
          height={height()}
          options={options()}
          onSelect={(_i: number, option: { value?: unknown } | null) => {
            if (option && typeof option.value === "string") removeProvider(option.value);
          }}
        />
      </Show>
    </OverlayFrame>
  );
}
