/**
 * Clipboard writing for the OpenTUI app.
 *
 * Ctrl+C with an active selection copies the selected text to the user's real
 * clipboard. We try native platform tools first and fall back to OSC 52 (the
 * terminal-controlled clipboard). Under SSH only OSC 52 is used, because a
 * local tool would write to the remote machine's clipboard instead of the
 * user's.
 *
 * Everything here is injectable for tests: `spawn`, `env`, `platform`, a
 * `which`-style `lookup`, and the two OSC 52 callbacks. The copied text is
 * never placed in argv — it is always fed to the tool on stdin — and it is
 * never logged.
 */
import { spawn } from "node:child_process";

export interface ClipboardWriteResult {
  ok: boolean;
  method: string;
}

/** Minimal structural view of a child process, compatible with node's spawn. */
export interface SpawnedProcess {
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
  stdin: NodeJS.WritableStream | null;
}

export interface SpawnOptions {
  stdio?: readonly ("pipe" | "ignore" | "inherit")[];
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => SpawnedProcess;

export interface NativeToolCandidate {
  id: string;
  command: string;
  args: readonly string[];
  encode: (text: string) => Uint8Array;
}

export interface ClipboardWriterDeps {
  spawn: SpawnFn | typeof spawn;
  env: Record<string, string | undefined>;
  platform: string;
  /** `which`-style lookup; returns the executable path or null when absent. */
  lookup?: (command: string) => Promise<string | null>;
  isOsc52Supported?: () => boolean;
  osc52?: (text: string) => boolean;
  timeoutMs?: number;
}

export function isSshEnv(env: Record<string, string | undefined>): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY);
}

/**
 * UTF-16LE with a leading BOM — the byte layout `clip.exe` expects so that
 * non-ASCII text survives (0xFF 0xFE followed by the UTF-16LE payload).
 */
export function utf16leWithBom(text: string): Uint8Array {
  const body = Buffer.from(text, "utf16le");
  const out = new Uint8Array(2 + body.length);
  out[0] = 0xff;
  out[1] = 0xfe;
  out.set(body, 2);
  return out;
}

function utf8(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

/**
 * Native clipboard tools for the current environment, in priority order.
 * Returns [] under SSH (OSC 52 only) and on unsupported platforms.
 */
export function nativeToolCandidates(
  env: Record<string, string | undefined>,
  platform: string,
): NativeToolCandidate[] {
  if (isSshEnv(env)) return [];

  const isWsl = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
  if (isWsl || platform === "win32") {
    return [{ id: "clip", command: "clip.exe", args: [], encode: utf16leWithBom }];
  }
  if (platform === "darwin") {
    return [{ id: "pbcopy", command: "pbcopy", args: [], encode: utf8 }];
  }
  if (platform === "linux") {
    // Gate X11/Wayland tools on the display server actually being present; a
    // tool spawned without a display can only fail (or hang). WSL is handled
    // above via clip.exe and is unaffected by this gate.
    const candidates: NativeToolCandidate[] = [];
    if (env.WAYLAND_DISPLAY) {
      candidates.push({ id: "wl-copy", command: "wl-copy", args: [], encode: utf8 });
    }
    if (env.DISPLAY) {
      candidates.push({
        id: "xclip",
        command: "xclip",
        args: ["-selection", "clipboard"],
        encode: utf8,
      });
      candidates.push({
        id: "xsel",
        command: "xsel",
        args: ["--clipboard", "--input"],
        encode: utf8,
      });
    }
    return candidates;
  }
  return [];
}

function osc52Write(text: string, deps: ClipboardWriterDeps): boolean {
  if (!deps.isOsc52Supported?.()) return false;
  return deps.osc52?.(text) ?? false;
}

async function runSpawnWrite(
  spawnFn: SpawnFn,
  command: string,
  args: readonly string[],
  text: string,
  encode: (text: string) => Uint8Array,
  timeoutMs: number,
): Promise<boolean> {
  let child: SpawnedProcess;
  try {
    child = spawnFn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
  } catch {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone; the close handler will settle us
      }
      finish(false);
    }, timeoutMs);

    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));

    if (!child.stdin) {
      finish(false);
      return;
    }
    // A stream error on stdin (most commonly EPIPE because the tool closed its
    // input early) never decides the outcome by itself — the process exit code
    // does. We also always reach end(): the data + EOF are sent in one call,
    // and the promise is settled exclusively by close (or the timeout).
    child.stdin.on("error", () => {});
    try {
      child.stdin.end(encode(text));
    } catch {
      // stdin already unusable; still wait for close or the timeout to settle.
    }
  });
}

/**
 * Copy `text` to the system clipboard.
 *
 * Under SSH only OSC 52 is attempted. Otherwise native tools are tried in
 * order; each failure (exit non-zero, spawn error, lookup miss, timeout) falls
 * through to the next option, and finally to OSC 52 when supported. Returns
 * `{ ok, method }`; `method` is the tool id or "osc52" on success, "none"
 * when nothing worked.
 */
export async function writeClipboardText(
  text: string,
  deps: ClipboardWriterDeps,
): Promise<ClipboardWriteResult> {
  const timeoutMs = deps.timeoutMs ?? 2000;

  if (isSshEnv(deps.env)) {
    return osc52Write(text, deps)
      ? { ok: true, method: "osc52" }
      : { ok: false, method: "none" };
  }

  for (const candidate of nativeToolCandidates(deps.env, deps.platform)) {
    const resolved = deps.lookup
      ? await deps.lookup(candidate.command)
      : candidate.command;
    if (!resolved) continue;
    const wrote = await runSpawnWrite(
      deps.spawn as SpawnFn,
      resolved,
      candidate.args,
      text,
      candidate.encode,
      timeoutMs,
    );
    if (wrote) return { ok: true, method: candidate.id };
  }

  if (osc52Write(text, deps)) {
    return { ok: true, method: "osc52" };
  }
  return { ok: false, method: "none" };
}

/** Overlay kinds reported by the TUI overlay state (`overlays/state.ts`). */
export type TuiOverlayKind =
  | "none"
  | "slash"
  | "model"
  | "login"
  | "logout"
  | "palette"
  | "setup"
  | "consent";

/**
 * Modal overlays take over the whole screen and own Ctrl+C themselves (cancel).
 * The global Ctrl+C binding deactivates while one of these is open so the
 * overlay's own handler always wins.
 */
const MODAL_OVERLAY_KINDS: readonly TuiOverlayKind[] = ["setup", "consent", "login", "logout"];

export function isModalOverlay(kind: string): boolean {
  return MODAL_OVERLAY_KINDS.includes(kind as TuiOverlayKind);
}

export type CtrlCCopyDecision =
  | { action: "copy"; text: string }
  | { action: "interrupt" }
  | { action: "cancel_overlay"; overlay: "palette" | "model" }
  | { action: "defer" };

/**
 * Pure decision for the TUI Ctrl+C handler.
 *
 * - Any selection with at least one character (including whitespace/newlines)
 *   copies — in the main UI and in the palette/model/slash overlays. Only a
 *   missing or empty-string selection falls through.
 * - Modal overlays (setup/consent/login/logout) own Ctrl+C themselves; the
 *   decision defers to them.
 * - Palette/model overlays cancel (close) when there is no selection, matching
 *   what Escape does; the main UI falls through to the interrupt path.
 */
export function decideCtrlC(
  hasSelection: boolean,
  getSelectedText: string,
  overlayKind: string = "none",
): CtrlCCopyDecision {
  if (isModalOverlay(overlayKind)) {
    return { action: "defer" };
  }
  const text = getSelectedText ?? "";
  if (hasSelection && [...text].length > 0) {
    return { action: "copy", text };
  }
  if (overlayKind === "palette" || overlayKind === "model") {
    return { action: "cancel_overlay", overlay: overlayKind };
  }
  return { action: "interrupt" };
}

export interface CopyOutcome {
  toast: string;
  tone: "info" | "warn";
  /** The selection must always be cleared after a copy attempt (success or failure). */
  clearSelection: boolean;
}

/**
 * Human-readable toast for a copy result. Counts code points (`[...text].length`),
 * not UTF-16 units. OSC 52 copies are honest about where the text went.
 */
export function copyToastMessage(result: ClipboardWriteResult, text: string): string {
  const count = [...text].length;
  if (!result.ok) {
    return "Could not copy: no clipboard available";
  }
  if (result.method === "osc52") {
    return `Sent ${count} characters to the terminal clipboard (OSC 52)`;
  }
  return `Copied ${count} characters`;
}

/** Outcome of a copy attempt: what toast to show and whether to clear the selection. */
export function copyOutcomeOf(result: ClipboardWriteResult, text: string): CopyOutcome {
  return {
    toast: copyToastMessage(result, text),
    tone: result.ok ? "info" : "warn",
    clearSelection: true,
  };
}

/**
 * Default `which`-style lookup: resolves to the tool path, or null when the
 * tool is missing — so missing tools are skipped instead of spawned blind.
 */
export async function defaultToolLookup(command: string): Promise<string | null> {
  return (await Bun.which(command)) ?? null;
}

export interface CopyRunState {
  inFlight: boolean;
}

export function createCopyRunState(): CopyRunState {
  return { inFlight: false };
}

export interface CopyRunCallbacks {
  onStarted?: () => void;
  onSettled?: (result: ClipboardWriteResult, text: string) => void;
}

/**
 * Run one copy attempt guarded against re-entrancy: while `state.inFlight` is
 * true, further calls are ignored (returning `started: false`), so rapid
 * Ctrl+C presses cannot spawn duplicate writes or double toasts. The flag is
 * always cleared in a `finally`, never leaving the copy permanently blocked.
 * Returns `{ started: false }` when a copy is already in flight.
 */
export function runGuardedCopy(
  text: string,
  deps: ClipboardWriterDeps,
  state: CopyRunState,
  callbacks: CopyRunCallbacks = {},
): { started: boolean } {
  if (state.inFlight) {
    return { started: false };
  }
  state.inFlight = true;
  callbacks.onStarted?.();
  void (async () => {
    let result: ClipboardWriteResult = { ok: false, method: "none" };
    try {
      result = await writeClipboardText(text, deps);
    } catch {
      result = { ok: false, method: "none" };
    } finally {
      state.inFlight = false;
      callbacks.onSettled?.(result, text);
    }
  })();
  return { started: true };
}
