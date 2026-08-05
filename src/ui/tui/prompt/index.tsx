/**
 * Solid Prompt — OpenCode-inspired chat input (imperative OpenTUI under the hood).
 *
 * Features: auto-grow, prompt history, large-paste collapse, slash/file autocomplete.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import {
  useTerminalDimensions,
  useRenderer,
} from "@opentui/solid";
import { useBindings } from "@opentui/keymap/solid";
import type { TextareaRenderable, PasteEvent } from "@opentui/core";
import { decodePasteBytes, stripAnsiSequences } from "@opentui/core";
import { PromptHistory } from "./history.js";
import {
  countLines,
  expandPasteChips,
  formatPasteChip,
  makePasteId,
  normalizePasteText,
  prunePasteStore,
  shouldCollapsePaste,
} from "./paste.js";
import {
  applyAutocomplete,
  getAutocomplete,
  type AutocompleteItem,
  type AutocompleteResult,
} from "./autocomplete.js";
import { TUI_PALETTE, TUI_STYLE } from "../theme.js";

const SUBMIT_BINDINGS = [
  { name: "return", action: "submit" as const },
  { name: "kpenter", action: "submit" as const },
  { name: "linefeed", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "kpenter", shift: true, action: "newline" as const },
];

export interface PromptProps {
  cwd: string;
  focused?: boolean;
  placeholder?: string;
  onSubmit: (text: string) => void | Promise<void>;
  /** Expose imperative helpers to the run bridge. */
  ref?: (api: PromptHandle | undefined) => void;
}

export interface PromptHandle {
  focus(): void;
  blur(): void;
  clear(): void;
  setText(text: string): void;
  getText(): string;
}

export function Prompt(props: PromptProps) {
  const dimensions = useTerminalDimensions();
  const renderer = useRenderer();
  let textarea: TextareaRenderable | undefined;
  const history = new PromptHistory();
  const pasteStore = new Map<string, string>();

  const [height, setHeight] = createSignal(1);
  const [ac, setAc] = createSignal<AutocompleteResult | null>(null);
  const [acIndex, setAcIndex] = createSignal(0);
  const [focused, setFocused] = createSignal(props.focused !== false);

  const maxHeight = createMemo(() =>
    Math.max(6, Math.floor((dimensions().height || 24) / 3)),
  );

  const syncHeight = (text: string) => {
    const lines = Math.max(1, countLines(text) || 1);
    setHeight(Math.min(maxHeight(), lines));
  };

  const api: PromptHandle = {
    focus() {
      setFocused(true);
      textarea?.focus();
      // EditBufferRenderable.blur() hides the terminal cursor; focus() only
      // re-asserts it during the next render pass, which can race Solid's
      // deferred overlay unmount after an overlay dismiss. Re-render now and
      // once more after the Solid flush so the cursor lands on the prompt.
      renderer.requestRender();
      queueMicrotask(() => renderer.requestRender());
    },
    blur() {
      setFocused(false);
      textarea?.blur();
    },
    clear() {
      textarea?.setText("");
      pasteStore.clear();
      history.resetBrowse();
      setAc(null);
      syncHeight("");
    },
    setText(text: string) {
      textarea?.setText(text);
      syncHeight(text);
    },
    getText() {
      return expandPasteChips(textarea?.plainText ?? "", pasteStore);
    },
  };

  createEffect(() => {
    props.ref?.(api);
    onCleanup(() => props.ref?.(undefined));
  });

  createEffect(() => {
    if (props.focused === false) {
      setFocused(false);
      textarea?.blur();
    } else if (props.focused === true) {
      setFocused(true);
      textarea?.focus();
    }
  });

  const refreshAutocomplete = async () => {
    if (!textarea) return;
    const text = textarea.plainText;
    const caret = textarea.cursorOffset ?? text.length;
    const result = await getAutocomplete(text, caret, props.cwd);
    setAc(result);
    setAcIndex(0);
  };

  const applyItem = (item: AutocompleteItem) => {
    const current = ac();
    if (!current || !textarea) return;
    const { text, caret } = applyAutocomplete(
      textarea.plainText,
      current.start,
      current.end,
      item,
    );
    textarea.setText(text);
    textarea.cursorOffset = caret;
    setAc(null);
    syncHeight(text);
    renderer.requestRender();
  };

  const handlePaste = (event: PasteEvent) => {
    event.preventDefault();
    const raw = stripAnsiSequences(decodePasteBytes(event.bytes));
    const normalized = normalizePasteText(raw);
    if (!normalized) return;
    if (!textarea) return;

    if (shouldCollapsePaste(normalized)) {
      const id = makePasteId();
      pasteStore.set(id, normalized.trim());
      const chip = formatPasteChip(countLines(normalized.trim()), id);
      textarea.insertText(chip);
    } else {
      textarea.insertText(normalized);
    }
    prunePasteStore(textarea.plainText, pasteStore);
    syncHeight(textarea.plainText);
    void refreshAutocomplete();
  };

  const acOpen = () => {
    const list = ac();
    return list !== null && list.items.length > 0;
  };

  const textMatchesItem = () => {
    if (!textarea) return false;
    const list = ac();
    if (!list) return false;
    const item = list.items[acIndex()];
    if (!item) return false;
    const text = textarea.plainText;
    return text.trimStart().startsWith(item.value) && text.trim() === item.value;
  };

  useBindings(() => ({
    target: () => textarea,
    targetMode: "focus",
    bindings: [
      // Autocomplete-open keys (gated together by `acOpen`).
      {
        key: "escape",
        enabled: () => acOpen(),
        cmd: () => setAc(null),
      },
      {
        key: "up",
        enabled: () => acOpen(),
        cmd: () => setAcIndex((i) => Math.max(0, i - 1)),
      },
      {
        key: "down",
        enabled: () => acOpen(),
        cmd: () => {
          const list = ac();
          if (!list) return;
          setAcIndex((i) => Math.min(list.items.length - 1, i + 1));
        },
      },
      {
        key: "tab",
        enabled: () => acOpen(),
        cmd: () => {
          const list = ac();
          if (!list) return;
          const item = list.items[acIndex()];
          if (item) applyItem(item);
        },
      },
      {
        key: "return",
        enabled: () => acOpen() && !textMatchesItem(),
        cmd: () => {
          const list = ac();
          if (!list) return;
          const item = list.items[acIndex()];
          if (item) applyItem(item);
        },
      },
      // When the buffer already equals the completion, close the popup and let
      // return fall through to the textarea's submit keybinding.
      {
        key: "return",
        enabled: () => acOpen() && textMatchesItem(),
        preventDefault: false,
        cmd: () => setAc(null),
      },
      // History navigation (only when autocomplete is closed).
      {
        key: "up",
        enabled: () => {
          if (acOpen() || !textarea) return false;
          return textarea.logicalCursor.row === 0;
        },
        cmd: () => {
          if (!textarea) return;
          const next = history.up(textarea.plainText);
          if (next !== null) {
            textarea.setText(next);
            syncHeight(next);
          }
        },
      },
      {
        key: "down",
        enabled: () => {
          if (acOpen() || !textarea) return false;
          const lineCount = countLines(textarea?.plainText ?? "") || 1;
          return (textarea?.logicalCursor.row ?? 0) >= lineCount - 1 && history.isBrowsing();
        },
        cmd: () => {
          if (!textarea) return;
          const next = history.down();
          if (next !== null) {
            textarea.setText(next);
            syncHeight(next);
          }
        },
      },
    ],
  }));

  const onSubmit = () => {
    if (!textarea) return;
    if (ac()) {
      // Enter while autocomplete open is handled in onKeyDown; don't double-submit.
      return;
    }
    const expanded = expandPasteChips(textarea.plainText, pasteStore).trim();
    if (!expanded) return;
    history.push(expanded);
    pasteStore.clear();
    textarea.setText("");
    syncHeight("");
    setAc(null);
    void props.onSubmit(expanded);
  };

  const popupY = createMemo(() => {
    // Prefer anchoring just above the prompt area (bottom chrome).
    const h = dimensions().height || 24;
    const items = ac()?.items.length ?? 0;
    const boxH = Math.min(8, Math.max(1, items));
    return Math.max(0, h - height() - boxH - 4);
  });

  return (
    <>
      <box
        id="prompt"
        width="100%"
        flexDirection="column"
        backgroundColor={TUI_PALETTE.inset}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
      >
        <box width="100%" flexDirection="row" minHeight={1}>
          <text>
            <span style={TUI_STYLE.accent}>❯</span>
          </text>
          <box width={2} flexShrink={0} />
          <textarea
            ref={(el: TextareaRenderable) => {
              textarea = el;
              el.onPaste = handlePaste;
            }}
            width="100%"
            flexGrow={1}
            minHeight={1}
            height={height()}
            focused={focused()}
            placeholder={props.placeholder ?? "message praana"}
            textColor="white"
            cursorColor="white"
            keyBindings={SUBMIT_BINDINGS}
            onContentChange={() => {
              const value = textarea?.plainText ?? "";
              prunePasteStore(value, pasteStore);
              syncHeight(value);
              void refreshAutocomplete();
            }}
            onCursorChange={() => {
              void refreshAutocomplete();
            }}
            onSubmit={onSubmit}
          />
        </box>
      </box>

      <Show when={ac()}>
        {(result) => (
          <select
            id="prompt-completions"
            position="absolute"
            zIndex={1100}
            left={2}
            top={popupY()}
            width={Math.min(60, (dimensions().width || 80) - 4)}
            height={Math.min(8, result().items.length)}
            options={result().items.map((item) => ({
              name: item.description ? `${item.label}  ${item.description}` : item.label,
              description: "",
              value: item.value,
            }))}
            selectedIndex={acIndex()}
            backgroundColor="#1a1a1a"
            selectedBackgroundColor="#334455"
            selectedTextColor="#ffffff"
            showScrollIndicator
            focused={false}
          />
        )}
      </Show>
    </>
  );
}
