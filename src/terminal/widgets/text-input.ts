import type { Buffer } from "../core/buffer.js";
import type { Rect } from "../core/rect.js";
import type { Style } from "../core/style.js";
import { Modifier, styleAddModifier } from "../core/style.js";
import type { StatefulWidget } from "./widget.js";

export interface TextInputState {
  value: string;
  cursor: number;
  placeholder?: string;
  focus: boolean;
}

export function createTextInputState(
  value = "",
  opts?: { placeholder?: string; focus?: boolean }
): TextInputState {
  return {
    value,
    cursor: value.length,
    placeholder: opts?.placeholder,
    focus: opts?.focus ?? true,
  };
}

export function textInputWidget(style: Style = {}): StatefulWidget<TextInputState> {
  const focusedStyle = styleAddModifier(style, Modifier.REVERSED);

  return {
    render(area: Rect, buf: Buffer, state: TextInputState) {
      const display = state.value.length > 0
        ? state.value
        : (state.placeholder ?? "");
      const isPlaceholder = state.value.length === 0 && state.placeholder;

      if (!state.focus) {
        buf.setString(area.x, area.y, display, style, area.width);
        return;
      }

      // Render with cursor highlight
      let col = area.x;
      const max = Math.min(display.length, area.width);
      for (let i = 0; i < max; i++) {
        const ch = display[i]!;
        const atCursor = i === state.cursor;
        const s = atCursor
          ? focusedStyle
          : isPlaceholder
            ? styleAddModifier(style, Modifier.DIM)
            : style;
        buf.setChar(col, area.y, ch, s);
        col++;
      }
      if (state.cursor >= display.length && col < area.x + area.width) {
        buf.setChar(col, area.y, " ", focusedStyle);
      }
    },
  };
}

export function textInputInsert(state: TextInputState, text: string): TextInputState {
  const before = state.value.slice(0, state.cursor);
  const after = state.value.slice(state.cursor);
  const value = before + text + after;
  return { ...state, value, cursor: state.cursor + text.length };
}

export function textInputBackspace(state: TextInputState): TextInputState {
  if (state.cursor <= 0) return state;
  const value = state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor);
  return { ...state, value, cursor: state.cursor - 1 };
}

export function textInputMoveLeft(state: TextInputState): TextInputState {
  return { ...state, cursor: Math.max(0, state.cursor - 1) };
}

export function textInputMoveRight(state: TextInputState): TextInputState {
  return { ...state, cursor: Math.min(state.value.length, state.cursor + 1) };
}

export function textInputSetValue(state: TextInputState, value: string): TextInputState {
  return { ...state, value, cursor: value.length };
}
