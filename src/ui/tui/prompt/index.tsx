/**
 * Solid Prompt — OpenCode-inspired chat input (imperative OpenTUI under the hood).
 *
 * Features: auto-grow, prompt history, large-paste collapse, slash/file autocomplete.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import {
  useTerminalDimensions,
  useRenderer,
} from "@opentui/solid";
import type { KeyEvent, TextareaRenderable, PasteEvent } from "@opentui/core";
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

  const onKeyDown = (key: KeyEvent) => {
    if (!textarea) return;
    const text = textarea.plainText;
    const list = ac();
    if (list && list.items.length > 0) {
      if (key.name === "escape") {
        setAc(null);
        key.preventDefault();
        return;
      }
      if (key.name === "up") {
        setAcIndex((i) => Math.max(0, i - 1));
        key.preventDefault();
        return;
      }
      if (key.name === "down") {
        setAcIndex((i) => Math.min(list.items.length - 1, i + 1));
        key.preventDefault();
        return;
      }
      if (key.name === "tab" || key.name === "return") {
        const item = list.items[acIndex()];
        if (item) {
          // If the buffer already contains the completion, let Enter submit instead.
          if (
            key.name === "return" &&
            text.trimStart().startsWith(item.value) &&
            text.trim() === item.value
          ) {
            setAc(null);
            // fall through to submit via keybinding
            return;
          }
          applyItem(item);
          key.preventDefault();
        }
        return;
      }
    }

    const cursor = textarea.logicalCursor;
    const lineCount = countLines(text) || 1;

    if (key.name === "up" && !key.ctrl && !key.meta && cursor.row === 0) {
      const next = history.up(text);
      if (next !== null) {
        textarea.setText(next);
        syncHeight(next);
        key.preventDefault();
      }
      return;
    }

    if (key.name === "down" && !key.ctrl && !key.meta && cursor.row >= lineCount - 1) {
      if (history.isBrowsing()) {
        const next = history.down();
        if (next !== null) {
          textarea.setText(next);
          syncHeight(next);
        }
        key.preventDefault();
      }
    }
  };

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
    const boxH = Math.min(8, Math.max(3, items + 2));
    return Math.max(0, h - height() - boxH - 4);
  });

  return (
    <>
      <box
        id="prompt"
        flexDirection="column"
        border={["top"]}
        borderColor="gray"
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
      >
        <box flexDirection="row" minHeight={1}>
          <text>❯ </text>
          <textarea
            ref={(el: TextareaRenderable) => {
              textarea = el;
              el.onPaste = handlePaste;
            }}
            flexGrow={1}
            minHeight={1}
            height={height()}
            focused={focused()}
            placeholder={props.placeholder ?? ""}
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
            onKeyDown={onKeyDown}
            onSubmit={onSubmit}
          />
        </box>
      </box>

      <Show when={ac()}>
        {(result) => (
          <box
            position="absolute"
            zIndex={1100}
            left={2}
            top={popupY()}
            width={Math.min(60, (dimensions().width || 80) - 4)}
            height={Math.min(8, result().items.length + 2)}
            border
            borderStyle="rounded"
            padding={1}
            title="completions"
            backgroundColor="#1a1a1a"
          >
            <For each={result().items}>
              {(item, i) => (
                <text>
                  {i() === acIndex() ? "› " : "  "}
                  {item.label}
                  {item.description ? `  ${item.description}` : ""}
                </text>
              )}
            </For>
          </box>
        )}
      </Show>
    </>
  );
}
