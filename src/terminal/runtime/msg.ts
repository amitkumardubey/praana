/** Key press message from stdin. */
export interface KeyMsg {
  type: "key";
  key: Key;
  input: string;
}

export interface Key {
  name?: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  escape: boolean;
  return: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  home: boolean;
  end: boolean;
}

export interface ResizeMsg {
  type: "resize";
  width: number;
  height: number;
}

export interface TickMsg {
  type: "tick";
}

export type SystemMsg = KeyMsg | ResizeMsg | TickMsg;

export function isKeyMsg(msg: unknown): msg is KeyMsg {
  return typeof msg === "object" && msg !== null && (msg as KeyMsg).type === "key";
}
