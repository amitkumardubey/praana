import * as readline from "node:readline";
import type { Key, KeyMsg } from "../runtime/msg.js";

export type KeyHandler = (msg: KeyMsg) => void;

/**
 * Attach raw-ish key listener via readline keypress events.
 * Returns cleanup function.
 */
export function attachKeyListener(onKey: KeyHandler): () => void {
  if (!process.stdin.isTTY) return () => {};

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  const handler = (_str: string, key: readline.Key) => {
    if (!key) return;
    onKey({
      type: "key",
      input: _str,
      key: parseKey(key),
    });
  };

  process.stdin.on("keypress", handler);
  process.stdin.resume();

  return () => {
    process.stdin.off("keypress", handler);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  };
}

function parseKey(key: readline.Key): Key {
  return {
    name: key.name,
    ctrl: !!key.ctrl,
    meta: !!key.meta,
    shift: !!key.shift,
    escape: key.name === "escape",
    return: key.name === "return",
    tab: key.name === "tab",
    backspace: key.name === "backspace",
    delete: key.name === "delete",
    upArrow: key.name === "up",
    downArrow: key.name === "down",
    leftArrow: key.name === "left",
    rightArrow: key.name === "right",
    pageUp: key.name === "pageup",
    pageDown: key.name === "pagedown",
    home: key.name === "home",
    end: key.name === "end",
  };
}
