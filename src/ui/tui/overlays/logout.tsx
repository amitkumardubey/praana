/**
 * Solid logout provider picker.
 */
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { listStoredProviders, removeApiKey } from "../../../credentials.js";
import { isUserDeclaredProvider } from "../../../provider-registry.js";
import { removeProviderSection } from "../../../setup/config-writer.js";
import { TUI_STYLE } from "../theme.js";
import { OverlayFrame } from "./frame.js";

export interface LogoutWizardResult {
  provider: string;
  message: string;
  sectionRemoved: boolean;
  isActiveProvider: boolean;
}

export interface LogoutOverlayProps {
  currentProvider: string;
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
    const isActive = provider === props.currentProvider;
    const isCustom = isUserDeclaredProvider(provider);
    const removed = removeApiKey(provider);
    let sectionRemoved = false;
    if (isCustom) {
      sectionRemoved = removeProviderSection(provider).written;
    }
    const parts: string[] = [];
    if (removed || sectionRemoved) parts.push(`Logged out: ${provider}`);
    else parts.push(`No credentials found for "${provider}".`);
    if (sectionRemoved) {
      parts.push(`Removed [providers.${provider}] from config.toml.`);
      parts.push("Run /new to fully deactivate the provider.");
    }
    if (isActive) {
      parts.push(`⚠ ${provider} is your active provider — the next turn may fail.`);
      parts.push("Use /login to re-add, or /model to switch.");
    }
    props.onComplete({
      provider,
      message: parts.join(" "),
      sectionRemoved,
      isActiveProvider: isActive,
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
