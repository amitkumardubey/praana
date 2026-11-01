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
import { readFileSync } from "node:fs";
import type { OverlayKind } from "./overlays/state.js";

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
  /**
   * Returns the contents of /proc/version (Linux WSL detection fallback),
   * or null when unreadable. Injectable for tests; defaults to reading the
   * real file.
   */
  readProcVersion?: () => string | null;
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
 * Memoizes a /proc/version reader: the kernel version cannot change within a
 * process, so the file is read at most once no matter how many copies run.
 */
export function memoizeReadProcVersion(
  read: () => string | null,
): () => string | null {
  let cached: string | null | undefined;
  return () => {
    if (cached === undefined) cached = read();
    return cached;
  };
}

function readProcVersionOnce(): string | null {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return null;
  }
}

/**
 * Default /proc/version reader: the file header line, or null when the file
 * is absent or unreadable (non-Linux hosts, sandboxes). Memoized.
 */
export const defaultReadProcVersion: () => string | null =
  memoizeReadProcVersion(readProcVersionOnce);

/**
 * Native clipboard tools for the current environment, in priority order.
 * Returns [] under SSH (OSC 52 only) and on unsupported platforms.
 */
export function nativeToolCandidates(
  env: Record<string, string | undefined>,
  platform: string,
  readProcVersion: () => string | null = defaultReadProcVersion,
): NativeToolCandidate[] {
  if (isSshEnv(env)) return [];

  // WSL is normally signaled via WSL_DISTRO_NAME/WSL_INTEROP, but both can be
  // absent (e.g. `bun` shebang invocations that strip them). As a fallback,
  // /proc/version on Linux carries a case-insensitive "microsoft" marker.
  const isWsl =
    Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP) ||
    (platform === "linux" && /microsoft/i.test(readProcVersion() ?? ""));
  if (platform === "win32") {
    return [{ id: "clip", command: "clip.exe", args: [], encode: utf16leWithBom }];
  }
  if (platform === "darwin") {
    return [{ id: "pbcopy", command: "pbcopy", args: [], encode: utf8 }];
  }
  if (platform === "linux") {
    // Gate X11/Wayland tools on the display server actually being present; a
    // tool spawned without a display can only fail (or hang).
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
    // Under WSL the Windows clipboard (clip.exe) is preferred; if interop is
    // disabled or clip.exe is missing, the WSLg Linux tools are the next best
    // option before giving up to OSC 52.
    if (isWsl) {
      return [
        { id: "clip", command: "clip.exe", args: [], encode: utf16leWithBom },
        ...candidates,
      ];
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

  for (const candidate of nativeToolCandidates(
    deps.env,
    deps.platform,
    deps.readProcVersion,
  )) {
    let resolved: string | null;
    if (deps.lookup) {
      try {
        resolved = await deps.lookup(candidate.command);
      } catch {
        // A lookup failure is treated like a miss: skip this tool and keep
        // walking the fallback chain.
        continue;
      }
    } else {
      resolved = candidate.command;
    }
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

/**
 * Modal overlays take over the whole screen and own Ctrl+C themselves (cancel).
 * The global Ctrl+C binding deactivates while one of these is open so the
 * overlay's own handler always wins.
 */
const MODAL_OVERLAY_KINDS: readonly OverlayKind[] = ["setup", "consent", "login", "logout"];

export function isModalOverlay(kind: OverlayKind): boolean {
  return MODAL_OVERLAY_KINDS.includes(kind);
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
 * - Palette/model overlays close when there is no selection, matching what
 *   Escape does — unless a turn is running, in which case Ctrl+C must still
 *   interrupt the turn (and may close the overlay).
 * - The main UI falls through to the interrupt path.
 */
export function decideCtrlC(
  hasSelection: boolean,
  getSelectedText: string,
  overlayKind: OverlayKind = "none",
  turnRunning: boolean = false,
): CtrlCCopyDecision {
  if (isModalOverlay(overlayKind)) {
    return { action: "defer" };
  }
  const text = getSelectedText ?? "";
  if (hasSelection && [...text].length > 0) {
    return { action: "copy", text };
  }
  if (overlayKind === "palette" || overlayKind === "model") {
    if (turnRunning) {
      return { action: "interrupt" };
    }
    return { action: "cancel_overlay", overlay: overlayKind };
  }
  return { action: "interrupt" };
}

export interface CopyOutcome {
  toast: string;
  tone: "info" | "warn";
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

export interface SelectionSnapshot {
  hasSelection: boolean;
  text: string;
}

/**
 * Whether to clear the selection after a copy settles. The copy clears the
 * selection only when the selection still holds exactly the text that was
 * copied; a selection made or changed while the copy was in flight is left
 * alone (it belongs to something else now).
 */
export function shouldClearSelectionAfterCopy(
  copiedText: string,
  current: SelectionSnapshot,
): boolean {
  return current.hasSelection && current.text === copiedText;
}

/** Outcome of a copy attempt: what toast to show and whether to clear the selection. */
export function copyOutcomeOf(result: ClipboardWriteResult, text: string): CopyOutcome {
  return {
    toast: copyToastMessage(result, text),
    tone: result.ok ? "info" : "warn",
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
  try {
    callbacks.onStarted?.();
  } catch {
    // A throwing onStarted must not leave the guard permanently engaged.
    state.inFlight = false;
    return { started: false };
  }
  void (async () => {
    let result: ClipboardWriteResult = { ok: false, method: "none" };
    try {
      result = await writeClipboardText(text, deps);
    } catch {
      result = { ok: false, method: "none" };
    } finally {
      state.inFlight = false;
      try {
        callbacks.onSettled?.(result, text);
      } catch {
        // The copy has already settled; a throwing observer must not surface
        // as an unhandled rejection or disturb the outcome.
      }
    }
  })();
  return { started: true };
}
