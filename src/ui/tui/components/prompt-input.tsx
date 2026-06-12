import React, { useState, useEffect } from "react";
import { Text, useInput, type Key } from "ink";
import chalk from "chalk";

export interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
  /** Called for single-char keys when the input is empty. Return true to consume. */
  onEmptyShortcut?: (key: string) => boolean;
  /** Scroll / escape keys — PromptInput owns stdin so these must be routed here. */
  onNavigationKey?: (key: Key, input: string) => boolean;
  onHistoryPrev?: () => string | null;
  onHistoryNext?: () => string | null;
}

/**
 * Prompt line input — ink-text-input fork with empty-input shortcut support.
 * Ink TextInput captures all keystrokes; shortcuts like `t` must be handled here.
 */
export function PromptInput({
  value: originalValue,
  placeholder = "",
  focus = true,
  onChange,
  onSubmit,
  onEmptyShortcut,
  onNavigationKey,
  onHistoryPrev,
  onHistoryNext,
}: PromptInputProps) {
  const [state, setState] = useState({
    cursorOffset: originalValue.length,
    cursorWidth: 0,
  });
  const { cursorOffset, cursorWidth } = state;

  useEffect(() => {
    setState((previousState) => {
      if (!focus) return previousState;
      const newValue = originalValue;
      if (previousState.cursorOffset > newValue.length - 1) {
        return { cursorOffset: newValue.length, cursorWidth: 0 };
      }
      return previousState;
    });
  }, [originalValue, focus]);

  const cursorActualWidth = 0;
  const value = originalValue;
  let renderedValue = value;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  if (focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(" ");
    renderedValue = value.length > 0 ? "" : chalk.inverse(" ");
    let i = 0;
    for (const char of value) {
      renderedValue +=
        i >= cursorOffset - cursorActualWidth && i <= cursorOffset
          ? chalk.inverse(char)
          : char;
      i++;
    }
    if (value.length > 0 && cursorOffset === value.length) {
      renderedValue += chalk.inverse(" ");
    }
  }

  useInput(
    (input, key) => {
      if (onNavigationKey?.(key, input)) {
        return;
      }

      if (key.upArrow && onHistoryPrev) {
        const prev = onHistoryPrev();
        if (prev !== null) {
          onChange(prev);
          setState({ cursorOffset: prev.length, cursorWidth: 0 });
          return;
        }
      }

      if (key.downArrow && onHistoryNext) {
        const next = onHistoryNext() ?? "";
        onChange(next);
        setState({ cursorOffset: next.length, cursorWidth: 0 });
        return;
      }

      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && input === "c") ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return;
      }

      if (key.return) {
        onSubmit?.(originalValue);
        return;
      }

      if (
        !key.ctrl &&
        !key.meta &&
        input.length === 1 &&
        originalValue.length === 0 &&
        onEmptyShortcut?.(input)
      ) {
        return;
      }

      let nextCursorOffset = cursorOffset;
      let nextValue = originalValue;
      let nextCursorWidth = 0;

      if (key.leftArrow) {
        nextCursorOffset--;
      } else if (key.rightArrow) {
        nextCursorOffset++;
      } else if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          nextValue =
            originalValue.slice(0, cursorOffset - 1) +
            originalValue.slice(cursorOffset);
          nextCursorOffset--;
        }
      } else if (input) {
        nextValue =
          originalValue.slice(0, cursorOffset) +
          input +
          originalValue.slice(cursorOffset);
        nextCursorOffset += input.length;
        if (input.length > 1) nextCursorWidth = input.length;
      }

      nextCursorOffset = Math.max(0, Math.min(nextCursorOffset, nextValue.length));
      setState({ cursorOffset: nextCursorOffset, cursorWidth: nextCursorWidth });
      if (nextValue !== originalValue) onChange(nextValue);
    },
    { isActive: focus }
  );

  return (
    <Text>
      {placeholder
        ? value.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  );
}
