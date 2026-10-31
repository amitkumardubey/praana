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
    return [
      { id: "wl-copy", command: "wl-copy", args: [], encode: utf8 },
      { id: "xclip", command: "xclip", args: ["-selection", "clipboard"], encode: utf8 },
      { id: "xsel", command: "xsel", args: ["--clipboard", "--input"], encode: utf8 },
    ];
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
    child.stdin.on("error", () => finish(false));
    try {
      child.stdin.write(encode(text), () => {
        try {
          child.stdin?.end();
        } catch {
          // stdin already closed
        }
      });
    } catch {
      finish(false);
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

export type CtrlCCopyDecision =
  | { action: "copy"; text: string }
  | { action: "interrupt" };

/**
 * Pure decision for the TUI Ctrl+C handler. A non-empty (non-whitespace)
 * OpenTUI selection wins over every existing interrupt behaviour; a missing,
 * empty, or whitespace-only selection falls through to the existing path
 * (abort turn / clear input / exit).
 */
export function decideCtrlC(
  hasSelection: boolean,
  getSelectedText: string,
): CtrlCCopyDecision {
  if (hasSelection) {
    const text = getSelectedText ?? "";
    if (text.trim().length > 0) {
      return { action: "copy", text };
    }
  }
  return { action: "interrupt" };
}
