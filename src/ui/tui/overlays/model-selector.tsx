/**
 * Solid searchable model selector (replaces imperative ModelSelector).
 */
import { createEffect, createSignal, onMount, Show } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { fuzzyFilter, type ModelListEntry } from "../../../model-listing.js";
import { TUI_STYLE } from "../theme.js";
import { OverlayFrame } from "./frame.js";

interface FlatModel {
  provider: string;
  modelId: string;
  contextWindow: number | null;
}

export interface ModelSelectorOverlayProps {
  currentProvider: string;
  currentModelId: string;
  maxVisible?: number;
  loadModels: () => Promise<ModelListEntry[]>;
  onSelect: (provider: string, modelId: string) => void;
  onCancel: () => void;
}

function formatCtx(window: number | null): string {
  if (window == null) return "";
  if (window >= 1_000_000) return ` ${(window / 1_000_000).toFixed(1)}M`;
  if (window >= 1000) return ` ${Math.round(window / 1000)}k`;
  return ` ${window}`;
}

export function ModelSelectorOverlay(props: ModelSelectorOverlayProps) {
  const renderer = useRenderer();
  const [query, setQuery] = createSignal("");
  const [allModels, setAllModels] = createSignal<FlatModel[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const maxVisible = () => props.maxVisible ?? 10;

  const indexOfCurrent = (list: FlatModel[]) => {
    const idx = list.findIndex(
      (m) => m.provider === props.currentProvider && m.modelId === props.currentModelId,
    );
    return idx >= 0 ? idx : 0;
  };

  const filtered = () => {
    const q = query().trim();
    const all = allModels();
    if (!q) return all;
    return fuzzyFilter(
      all,
      q,
      (m) => `${m.provider} ${m.modelId} ${m.provider}/${m.modelId}`,
    );
  };

  const options = () =>
    filtered().map((item) => {
      const isCurrent =
        item.provider === props.currentProvider && item.modelId === props.currentModelId;
      return {
        name: `${item.modelId} [${item.provider}]${formatCtx(item.contextWindow)}${isCurrent ? " ✓" : ""}`,
        description: "",
        value: `${item.provider}/${item.modelId}`,
      };
    });

  onMount(() => {
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const entries = await props.loadModels();
        const flat = entries.map((e) => ({
          provider: e.provider,
          modelId: e.modelId,
          contextWindow: e.contextWindow,
        }));
        flat.sort((a, b) => {
          const aCurrent =
            a.provider === props.currentProvider && a.modelId === props.currentModelId;
          const bCurrent =
            b.provider === props.currentProvider && b.modelId === props.currentModelId;
          if (aCurrent && !bCurrent) return -1;
          if (!aCurrent && bCurrent) return 1;
          const byProvider = a.provider.localeCompare(b.provider);
          if (byProvider !== 0) return byProvider;
          return a.modelId.localeCompare(b.modelId);
        });
        setAllModels(flat);
        setSelectedIndex(indexOfCurrent(flat));
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        renderer.requestRender();
      }
    })();
  });

  createEffect(() => {
    const list = filtered();
    const idx = selectedIndex();
    if (idx >= list.length) setSelectedIndex(Math.max(0, list.length - 1));
  });

  const commit = (value: string) => {
    const idx = value.indexOf("/");
    if (idx > 0) {
      props.onSelect(value.slice(0, idx), value.slice(idx + 1));
    }
  };

  return (
    <OverlayFrame width={56}>
      <text>{TUI_STYLE.info("Select model")}</text>
      <input
        focused
        placeholder="Search models…"
        onInput={(v: string) => {
          setQuery(v);
          const q = v.trim();
          if (!q) setSelectedIndex(indexOfCurrent(allModels()));
          else setSelectedIndex(0);
        }}
        onSubmit={() => {
          const item = filtered()[selectedIndex()];
          if (item) commit(`${item.provider}/${item.modelId}`);
        }}
      />
      <Show when={loading()}>
        <text>{TUI_STYLE.muted("Loading models…")}</text>
      </Show>
      <Show when={loadError()}>
        {(err) => <text>{TUI_STYLE.error(err())}</text>}
      </Show>
      <Show when={!loading() && !loadError()}>
        <select
          focused={false}
          height={maxVisible()}
          showScrollIndicator
          options={options()}
          selectedIndex={selectedIndex()}
          onSelect={(_index: number, option: { value?: unknown } | null) => {
            if (option && typeof option.value === "string") commit(option.value);
          }}
        />
      </Show>
    </OverlayFrame>
  );
}
