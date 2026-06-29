import {
  enterAltScreenAnsi,
  leaveAltScreenAnsi,
  setAutoWrapAnsi,
  showCursorAnsi,
} from "../render/diff.js";

export interface TerminalLifecycleOptions {
  alternateScreen?: boolean;
  hideCursor?: boolean;
}

export function enterTerminal(opts: TerminalLifecycleOptions = {}): string {
  const parts: string[] = [];
  if (opts.alternateScreen) parts.push(enterAltScreenAnsi());
  // The program loop owns the whole screen via absolute cursor positioning, so
  // autowrap must be off — otherwise writing the bottom-right cell scrolls the
  // view. Restored on leave.
  parts.push(setAutoWrapAnsi(false));
  if (opts.hideCursor !== false) parts.push(showCursorAnsi(false));
  return parts.join("");
}

export function leaveTerminal(opts: TerminalLifecycleOptions = {}): string {
  const parts: string[] = [setAutoWrapAnsi(true)];
  if (opts.alternateScreen) parts.push(leaveAltScreenAnsi());
  else parts.push(showCursorAnsi(true));
  return parts.join("");
}
