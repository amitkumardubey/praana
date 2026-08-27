/**
 * Solid logout provider picker.
 */
import { createSignal, onMount, Show } from "solid-js";
import { listStoredProviders } from "../../../credentials.js";
import { isUserDeclaredProvider } from "../../../provider-registry.js";
import { searchAliasesForProvider } from "../../../setup/provider-options.js";
import { logoutProvider } from "../../../setup/logout.js";
import { TUI_STYLE } from "../theme.js";
import { OverlayFrame } from "./frame.js";
import { PaletteList } from "./picker.js";

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
  initialProvider?: string;
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
    return {
      name: p,
      description: tags.join(", "),
      value: p,
      aliases: searchAliasesForProvider(p),
    };
  });
}

export function LogoutOverlay(props: LogoutOverlayProps) {
  const [options, setOptions] = createSignal(buildOptions(props.currentProvider));
  const pickerQuery = props.initialProvider?.toLowerCase().trim() ?? "";

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
    <OverlayFrame width={56}>
      <text><span style={TUI_STYLE.info}>Logout — select a provider to remove</span></text>
      <Show
        when={options().length > 0}
        fallback={<text><span style={TUI_STYLE.muted}>No stored credentials.</span></text>}
      >
        <PaletteList
          placeholder="search providers…"
          options={options()}
          initialQuery={pickerQuery}
          onSelect={(value) => removeProvider(value)}
        />
      </Show>
    </OverlayFrame>
  );
}
