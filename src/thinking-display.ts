/**
 * Pure helpers for the thinking block display.
 *
 * Extracted from main.ts so the buffering / summary / toggle logic
 * can be unit-tested without mocking process.stdout or stdin.
 */

export interface ThinkingState {
  open: boolean;
  buffer: string;
  visible: boolean;
}

export function createThinkingState(initialVisible: boolean): ThinkingState {
  return { open: false, buffer: "", visible: initialVisible };
}

/** Append a thinking delta to the buffer. Returns whether the header should be printed. */
export function onThinkingDelta(
  state: ThinkingState,
  delta: string,
): { printHeader: boolean; printDelta: boolean } {
  if (!state.visible) {
    return { printHeader: false, printDelta: false };
  }
  state.buffer += delta;
  if (!state.open) {
    state.open = true;
    return { printHeader: true, printDelta: true };
  }
  return { printHeader: false, printDelta: true };
}

/** Close the thinking block. Returns the summary line (or null if empty). */
export function closeThinking(state: ThinkingState): string | null {
  if (!state.open) return null;
  const summary =
    state.buffer.trim().length > 0
      ? `  [thinking: ${state.buffer.trim().length} chars]`
      : null;
  state.open = false;
  state.buffer = "";
  return summary;
}

/** Toggle visibility. Returns the new state. */
export function toggleThinking(state: ThinkingState): boolean {
  state.visible = !state.visible;
  return state.visible;
}
