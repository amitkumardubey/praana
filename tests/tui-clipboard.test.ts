/**
 * Unit tests for the TUI clipboard writer (`src/ui/tui/clipboard.ts`) and the
 * pure Ctrl+C decision helper.
 *
 * Coverage: method selection per environment (WSL, macOS, Linux Wayland / X11,
 * SSH, Windows), UTF-16LE+BOM bytes for clip.exe, tool-failure fallback,
 * total-failure result when no tool and OSC 52 are available, "text never in
 * argv", timeout handling, and the selection→copy vs empty-selection→interrupt
 * decision. Also: whitespace-only selections copy, overlay-kind precedence,
 * Linux display-server gating, default `which` lookup (null on miss), the
 * in-flight copy guard, stdin EPIPE resilience, and toast wording (OSC 52 vs
 * native, code-point counts, failed-copy selection clearing).
 */
import { describe, expect, it } from "bun:test";
import {
  copyOutcomeOf,
  copyToastMessage,
  createCopyRunState,
  decideCtrlC,
  defaultToolLookup,
  isModalOverlay,
  isSshEnv,
  memoizeReadProcVersion,
  nativeToolCandidates,
  runGuardedCopy,
  shouldClearSelectionAfterCopy,
  utf16leWithBom,
  writeClipboardText,
  type SpawnedProcess,
} from "../src/ui/tui/clipboard.js";
import type { OverlayKind } from "../src/ui/tui/overlays/state.js";

type FakeExitMode = "ok" | "fail" | "spawn-error" | "timeout";

interface FakeSpawnCall {
  command: string;
  args: readonly string[];
  stdinBytes: Uint8Array;
  stdinEnded: boolean;
}

interface FakeSpawnOptions {
  /** Emit an EPIPE error on the child's stdin before it closes. */
  epipe?: boolean;
}

function makeFakeSpawn(modes: FakeExitMode[], opts: FakeSpawnOptions = {}) {
  const calls: FakeSpawnCall[] = [];
  let index = 0;
  const spawnFn = (
    command: string,
    args: readonly string[],
    _opts?: unknown,
  ): SpawnedProcess => {
    const call: FakeSpawnCall = { command, args, stdinBytes: new Uint8Array(), stdinEnded: false };
    calls.push(call);
    const mode = modes[Math.min(index, modes.length - 1)] ?? "ok";
    index += 1;

    const stdin = {
      errorListener: null as ((err: Error) => void) | null,
      write(data: Uint8Array, cb?: () => void) {
        const next = new Uint8Array(call.stdinBytes.length + data.length);
        next.set(call.stdinBytes, 0);
        next.set(data, call.stdinBytes.length);
        call.stdinBytes = next;
        cb?.();
      },
      end(data?: Uint8Array) {
        if (data) {
          const next = new Uint8Array(call.stdinBytes.length + data.length);
          next.set(call.stdinBytes, 0);
          next.set(data, call.stdinBytes.length);
          call.stdinBytes = next;
        }
        call.stdinEnded = true;
      },
      on(ev: string, cb: unknown) {
        if (ev === "error") stdin.errorListener = cb as (err: Error) => void;
      },
    };

    const proc = {
      stdin: stdin as unknown as NodeJS.WritableStream,
      listeners: {
        error: (_err: Error) => {},
        close: (_code: number | null) => {},
      },
      on(ev: "error" | "close", cb: unknown) {
        if (ev === "error") {
          this.listeners.error = cb as (err: Error) => void;
        } else {
          this.listeners.close = cb as (code: number | null) => void;
        }
        return proc;
      },
      kill() {},
    };

    queueMicrotask(() => {
      if (mode === "spawn-error") {
        proc.listeners.error(new Error("ENOENT"));
        proc.listeners.close(-1);
        return;
      }
      if (mode === "timeout") {
        // Never closes; the parent timeout must kill + fail us.
        return;
      }
      if (opts.epipe) {
        const err = new Error("write EPIPE") as NodeJS.ErrnoException;
        err.code = "EPIPE";
        stdin.errorListener?.(err);
      }
      proc.listeners.close(mode === "fail" ? 1 : 0);
    });

    return proc;
  };
  return { spawnFn, calls };
}

/** A spawn whose close is deferred until the test decides (for in-flight guard tests). */
function makeDeferredSpawn() {
  const calls: FakeSpawnCall[] = [];
  let closeFn: (code: number | null) => void = () => {};
  const proc = {
    stdin: {
      end() {},
      on() {},
    } as unknown as NodeJS.WritableStream,
    listeners: {
      error: (_err: Error) => {},
      close: (_code: number | null) => {},
    },
    on(ev: "error" | "close", cb: unknown) {
      if (ev === "error") {
        this.listeners.error = cb as (err: Error) => void;
      } else {
        closeFn = cb as (code: number | null) => void;
      }
      return proc;
    },
    kill() {},
  };
  const spawnFn = (command: string, args: readonly string[]): SpawnedProcess => {
    calls.push({ command, args, stdinBytes: new Uint8Array(), stdinEnded: false });
    return proc;
  };
  return { spawnFn, calls, close: (code: number | null) => closeFn(code) };
}

function envWith(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { HOME: "/home/user", ...overrides };
}

function bytesOf(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

const LINUX_DISPLAY = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" };

// A /proc/version line without the WSL "microsoft" marker, for tests that
// exercise plain non-WSL Linux behavior deterministically.
const NON_WSL_PROC_VERSION = "Linux version 6.1.0-18-amd64 (debian/kernel)";

describe("clipboard writer — native tool selection per environment", () => {
  it("WSL uses clip.exe with UTF-16LE+BOM", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("AΩ", {
      spawn: spawnState.spawnFn,
      env: envWith({ WSL_DISTRO_NAME: "Ubuntu" }),
      platform: "linux",
      lookup: async (cmd) => cmd,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("clip");
    expect(spawnState.calls).toHaveLength(1);
    expect(spawnState.calls[0]!.command).toBe("clip.exe");
    expect(spawnState.calls[0]!.args).toEqual([]);
    expect(Buffer.from(spawnState.calls[0]!.stdinBytes).equals(Buffer.from(utf16leWithBom("AΩ")))).toBe(true);
  });

  it("Windows uses clip with UTF-16LE+BOM", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("Hi", {
      spawn: spawnState.spawnFn,
      env: envWith(),
      platform: "win32",
      lookup: async (cmd) => cmd,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("clip");
    expect(spawnState.calls[0]!.command).toBe("clip.exe");
    expect(Buffer.from(spawnState.calls[0]!.stdinBytes).equals(Buffer.from(utf16leWithBom("Hi")))).toBe(true);
  });

  it("Linux WSL fallback: /proc/version containing 'microsoft' (case-insensitive) selects clip.exe", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(),
      platform: "linux",
      lookup: async (cmd) => cmd,
      readProcVersion: () => "Linux version 6.1.90.1-microsoft-standard-WSL2 (WSL kernel)",
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("clip");
    expect(spawnState.calls).toHaveLength(1);
    expect(spawnState.calls[0]!.command).toBe("clip.exe");
  });

  it("macOS uses pbcopy with raw UTF-8 on stdin", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("héllo", {
      spawn: spawnState.spawnFn,
      env: envWith(),
      platform: "darwin",
      lookup: async (cmd) => cmd,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("pbcopy");
    expect(spawnState.calls).toHaveLength(1);
    expect(spawnState.calls[0]!.command).toBe("pbcopy");
    expect(spawnState.calls[0]!.args).toEqual([]);
    expect(Buffer.from(spawnState.calls[0]!.stdinBytes).equals(bytesOf("héllo"))).toBe(true);
  });

  it("Linux Wayland uses wl-copy first", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith({ WAYLAND_DISPLAY: "wayland-0" }),
      platform: "linux",
      lookup: async (cmd) => cmd,
      readProcVersion: () => NON_WSL_PROC_VERSION,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("wl-copy");
    expect(spawnState.calls).toHaveLength(1);
    expect(spawnState.calls[0]!.command).toBe("wl-copy");
  });

  it("Linux X11 (no Wayland) uses xclip, then falls back to xsel", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith({ DISPLAY: ":0" }),
      platform: "linux",
      lookup: async (cmd) => cmd,
      readProcVersion: () => NON_WSL_PROC_VERSION,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("xclip");
    expect(spawnState.calls.map((c) => c.command)).toEqual(["xclip"]);
    expect(spawnState.calls[0]!.args).toEqual(["-selection", "clipboard"]);

    const fallback = makeFakeSpawn(["fail", "ok"]);
    const result2 = await writeClipboardText("text", {
      spawn: fallback.spawnFn,
      env: envWith({ DISPLAY: ":0" }),
      platform: "linux",
      lookup: async (cmd) => cmd,
      readProcVersion: () => NON_WSL_PROC_VERSION,
    });
    expect(result2.ok).toBe(true);
    expect(result2.method).toBe("xsel");
    expect(fallback.calls.map((c) => c.command)).toEqual(["xclip", "xsel"]);
    expect(fallback.calls[1]!.args).toEqual(["--clipboard", "--input"]);
  });

  it("Linux with no display-server env has no native candidates (skip lists)", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(),
      platform: "linux",
      lookup: async (cmd) => cmd,
      readProcVersion: () => NON_WSL_PROC_VERSION,
      isOsc52Supported: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.method).toBe("none");
    expect(spawnState.calls).toHaveLength(0);
  });

  it("SSH mode never spawns a native tool and uses OSC 52 only", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    let osc52Called = false;
    const result = await writeClipboardText("secret", {
      spawn: spawnState.spawnFn,
      env: envWith({ SSH_CONNECTION: "10.0.0.2 1234 10.0.0.1 22" }),
      platform: "linux",
      lookup: async (cmd) => cmd,
      isOsc52Supported: () => true,
      osc52: (text) => {
        osc52Called = true;
        expect(text).toBe("secret");
        return true;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("osc52");
    expect(spawnState.calls).toHaveLength(0);
    expect(osc52Called).toBe(true);
  });
});

describe("clipboard writer — UTF-16LE+BOM bytes for clip.exe", () => {
  it("ASCII text is BOM + UTF-16LE", () => {
    expect(Array.from(utf16leWithBom("A"))).toEqual([0xff, 0xfe, 0x41, 0x00]);
  });

  it("non-ASCII text survives round-trip (BOM + UTF-16LE)", () => {
    const bytes = Buffer.from(utf16leWithBom("Ωé"));
    expect(bytes.readUInt16LE(0)).toBe(0xfeff);
    expect(bytes.slice(2).toString("utf16le")).toBe("Ωé");
  });

  it("multi-character text keeps exact UTF-16LE length", () => {
    const bytes = Buffer.from(utf16leWithBom("abc"));
    expect(bytes.length).toBe(2 + 3 * 2);
    expect(bytes.slice(2).toString("utf16le")).toBe("abc");
  });
});

describe("clipboard writer — tool failure and fallback", () => {
  it("a spawned tool that exits non-zero falls through to the next option", async () => {
    const spawnState = makeFakeSpawn(["fail", "ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(LINUX_DISPLAY),
      platform: "linux",
      lookup: async (cmd) => cmd,
      readProcVersion: () => NON_WSL_PROC_VERSION,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("xclip");
  });

  it("a spawn error (ENOENT) falls through to the next option", async () => {
    const spawnState = makeFakeSpawn(["spawn-error", "ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(LINUX_DISPLAY),
      platform: "linux",
      lookup: async (cmd) => cmd,
      readProcVersion: () => NON_WSL_PROC_VERSION,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("xclip");
  });

  it("a lookup miss skips the tool entirely", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(LINUX_DISPLAY),
      platform: "linux",
      lookup: async () => null,
      readProcVersion: () => NON_WSL_PROC_VERSION,
      isOsc52Supported: () => true,
      osc52: () => true,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("osc52");
    expect(spawnState.calls).toHaveLength(0);
  });

  it("a hung tool is killed by the timeout and falls through", async () => {
    const spawnState = makeFakeSpawn(["timeout", "ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(LINUX_DISPLAY),
      platform: "linux",
      lookup: async (cmd) => cmd,
      readProcVersion: () => NON_WSL_PROC_VERSION,
      timeoutMs: 20,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("xclip");
  }, 5000);

  it("native failure falls back to OSC 52 when supported", async () => {
    const spawnState = makeFakeSpawn(["fail"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(LINUX_DISPLAY),
      platform: "linux",
      lookup: async (cmd) => cmd,
      readProcVersion: () => NON_WSL_PROC_VERSION,
      isOsc52Supported: () => true,
      osc52: () => true,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("osc52");
  });

  it("no tool and OSC 52 unsupported → failure result", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(),
      platform: "linux",
      lookup: async () => null,
      isOsc52Supported: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.method).toBe("none");
    expect(spawnState.calls).toHaveLength(0);
  });

  it("SSH with OSC 52 unsupported → failure result", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith({ SSH_TTY: "/dev/pts/1" }),
      platform: "linux",
      lookup: async (cmd) => cmd,
      isOsc52Supported: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.method).toBe("none");
    expect(spawnState.calls).toHaveLength(0);
  });

  it("SSH with a failing OSC 52 write → failure result", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith({ SSH_CONNECTION: "a b c d" }),
      platform: "linux",
      lookup: async (cmd) => cmd,
      isOsc52Supported: () => true,
      osc52: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.method).toBe("none");
    expect(spawnState.calls).toHaveLength(0);
  });
});

describe("clipboard writer — text never appears in argv", () => {
  it("the copied text is passed on stdin, never as an argument", async () => {
    const text = "top secret payload with spaces; rm -rf /";
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText(text, {
      spawn: spawnState.spawnFn,
      env: envWith(),
      platform: "darwin",
      lookup: async (cmd) => cmd,
    });
    expect(result.ok).toBe(true);
    expect(spawnState.calls).toHaveLength(1);
    const call = spawnState.calls[0]!;
    for (const arg of call.args) {
      expect(arg).not.toContain(text);
      expect(arg).not.toBe(text);
    }
    expect(call.args.join(" ")).not.toContain(text);
    expect(Buffer.from(call.stdinBytes).equals(bytesOf(text))).toBe(true);
  });
});

describe("clipboard writer — stdin EPIPE resilience", () => {
  it("EPIPE on the child's stdin does not fail a copy that exits 0", async () => {
    const spawnState = makeFakeSpawn(["ok"], { epipe: true });
    const result = await writeClipboardText("hi", {
      spawn: spawnState.spawnFn,
      env: envWith(LINUX_DISPLAY),
      platform: "linux",
      lookup: async (cmd) => cmd,
      readProcVersion: () => NON_WSL_PROC_VERSION,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("wl-copy");
    expect(spawnState.calls).toHaveLength(1);
    expect(spawnState.calls[0]!.stdinEnded).toBe(true);
  });

  it("a non-zero exit still fails the copy even when stdin errored", async () => {
    const spawnState = makeFakeSpawn(["fail"], { epipe: true });
    const result = await writeClipboardText("hi", {
      spawn: spawnState.spawnFn,
      env: envWith(LINUX_DISPLAY),
      platform: "linux",
      lookup: async (cmd) => cmd,
      readProcVersion: () => NON_WSL_PROC_VERSION,
      isOsc52Supported: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.method).toBe("none");
  });

  it("stdin end() is always reached and the promise always settles", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("hi", {
      spawn: spawnState.spawnFn,
      env: envWith(LINUX_DISPLAY),
      platform: "linux",
      lookup: async (cmd) => cmd,
      readProcVersion: () => NON_WSL_PROC_VERSION,
    });
    expect(spawnState.calls[0]!.stdinEnded).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe("Ctrl+C decision — selection present vs empty selection", () => {
  it("selection present with non-empty text → copy, no interrupt", () => {
    const decision = decideCtrlC(true, "some text");
    expect(decision.action).toBe("copy");
    if (decision.action === "copy") {
      expect(decision.text).toBe("some text");
    }
  });

  it("selection present with non-empty text keeps exact whitespace", () => {
    const decision = decideCtrlC(true, "  padded  ");
    expect(decision).toEqual({ action: "copy", text: "  padded  " });
  });

  it("whitespace-only selection still copies (any non-empty selection)", () => {
    expect(decideCtrlC(true, "  \n\t ")).toEqual({ action: "copy", text: "  \n\t " });
    expect(decideCtrlC(true, "   ")).toEqual({ action: "copy", text: "   " });
  });

  it("empty selection → existing interrupt path", () => {
    expect(decideCtrlC(false, "")).toEqual({ action: "interrupt" });
  });

  it("selection present but text empty → existing interrupt path", () => {
    expect(decideCtrlC(true, "")).toEqual({ action: "interrupt" });
  });
});

describe("Ctrl+C decision — overlay kind precedence", () => {
  it("palette: selection copies, no selection cancels the palette", () => {
    expect(decideCtrlC(true, "sel", "palette")).toEqual({ action: "copy", text: "sel" });
    expect(decideCtrlC(false, "", "palette")).toEqual({ action: "cancel_overlay", overlay: "palette" });
  });

  it("model: selection copies, no selection dismisses the selector", () => {
    expect(decideCtrlC(true, "sel", "model")).toEqual({ action: "copy", text: "sel" });
    expect(decideCtrlC(false, "", "model")).toEqual({ action: "cancel_overlay", overlay: "model" });
  });

  it("slash: selection copies, no selection falls through to the overlay's any-key dismiss", () => {
    expect(decideCtrlC(true, "sel", "slash")).toEqual({ action: "copy", text: "sel" });
    expect(decideCtrlC(false, "", "slash")).toEqual({ action: "interrupt" });
  });

  it("modal overlays (setup/consent/login/logout) defer to their own Ctrl+C handling", () => {
    for (const kind of ["setup", "consent", "login", "logout"] as const) {
      expect(decideCtrlC(true, "sel", kind)).toEqual({ action: "defer" });
      expect(decideCtrlC(false, "", kind)).toEqual({ action: "defer" });
      expect(isModalOverlay(kind)).toBe(true);
    }
  });

  it("isModalOverlay is false for the main UI and non-modal overlays", () => {
    expect(isModalOverlay("none")).toBe(false);
    expect(isModalOverlay("palette")).toBe(false);
    expect(isModalOverlay("model")).toBe(false);
    expect(isModalOverlay("slash")).toBe(false);
  });
});

describe("Ctrl+C decision — running turn with palette/model overlays", () => {
  it("model selector + no selection + running turn → interrupt (not cancel_overlay)", () => {
    expect(decideCtrlC(false, "", "model", true)).toEqual({ action: "interrupt" });
  });

  it("palette + no selection + running turn → interrupt", () => {
    expect(decideCtrlC(false, "", "palette", true)).toEqual({ action: "interrupt" });
  });

  it("model/palette + no selection + idle → still cancel the overlay", () => {
    expect(decideCtrlC(false, "", "model", false)).toEqual({ action: "cancel_overlay", overlay: "model" });
    expect(decideCtrlC(false, "", "palette", false)).toEqual({ action: "cancel_overlay", overlay: "palette" });
  });

  it("selection still copies in the model selector while a turn runs", () => {
    expect(decideCtrlC(true, "sel", "model", true)).toEqual({ action: "copy", text: "sel" });
  });

  it("modal overlays still defer while a turn runs", () => {
    expect(decideCtrlC(false, "", "login", true)).toEqual({ action: "defer" });
  });

  it("main UI keeps the interrupt path while a turn runs", () => {
    expect(decideCtrlC(false, "", "none", true)).toEqual({ action: "interrupt" });
  });
});

describe("copy selection identity clearing after settle", () => {
  it("clears only when the current selection is exactly the copied text", () => {
    expect(shouldClearSelectionAfterCopy("abc", { hasSelection: true, text: "abc" })).toBe(true);
    expect(shouldClearSelectionAfterCopy("abc", { hasSelection: true, text: "xyz" })).toBe(false);
    expect(shouldClearSelectionAfterCopy("abc", { hasSelection: true, text: "ab" })).toBe(false);
    expect(shouldClearSelectionAfterCopy("abc", { hasSelection: false, text: "" })).toBe(false);
  });
});

describe("copy outcome — toast text, tone, and selection clearing", () => {
  it("native tool success → info toast 'Copied N characters', no clearSelection flag", () => {
    const outcome = copyOutcomeOf({ ok: true, method: "xclip" }, "some text");
    expect(outcome).toEqual({
      toast: "Copied 9 characters",
      tone: "info",
    });
    expect(outcome).not.toHaveProperty("clearSelection");
  });

  it("OSC 52 success → info toast 'Sent N characters … (OSC 52)', counts code points", () => {
    expect(copyOutcomeOf({ ok: true, method: "osc52" }, "a😀b")).toEqual({
      toast: "Sent 3 characters to the terminal clipboard (OSC 52)",
      tone: "info",
    });
    expect(copyToastMessage({ ok: true, method: "osc52" }, "a😀b")).toBe(
      "Sent 3 characters to the terminal clipboard (OSC 52)",
    );
    expect(copyToastMessage({ ok: true, method: "xclip" }, "a😀b")).toBe("Copied 3 characters");
  });

  it("failed copy → warn toast, no clearSelection flag (selection clearing is the caller's call)", () => {
    const outcome = copyOutcomeOf({ ok: false, method: "none" }, "sel");
    expect(outcome).toEqual({
      toast: "Could not copy: no clipboard available",
      tone: "warn",
    });
    expect(outcome).not.toHaveProperty("clearSelection");
  });
});

describe("clipboard helpers — environment predicates and candidates", () => {
  it("isSshEnv detects SSH_CONNECTION and SSH_TTY", () => {
    expect(isSshEnv(envWith())).toBe(false);
    expect(isSshEnv(envWith({ SSH_CONNECTION: "x y z w" }))).toBe(true);
    expect(isSshEnv(envWith({ SSH_TTY: "/dev/pts/0" }))).toBe(true);
  });

  it("nativeToolCandidates uses /proc/version as a WSL fallback on Linux only", () => {
    const microsoft = "Linux version 5.15.90.1-microsoft-standard-WSL2 (WSL kernel)";
    expect(nativeToolCandidates(envWith(), "linux", () => microsoft).map((c) => c.id)).toEqual(["clip"]);
    expect(nativeToolCandidates(envWith(), "linux", () => "Linux version 6.1.0-18-microsoft-standard")
      .map((c) => c.id)).toEqual(["clip"]);
    // Fallback is gated to Linux: the same marker on macOS must not select clip.exe.
    expect(nativeToolCandidates(envWith(), "darwin", () => microsoft).map((c) => c.id)).toEqual(["pbcopy"]);
    // No marker → unchanged non-WSL behavior (display-gated).
    expect(
      nativeToolCandidates(envWith({ DISPLAY: ":0" }), "linux", () => NON_WSL_PROC_VERSION)
        .map((c) => c.id),
    ).toEqual(["xclip", "xsel"]);
    expect(nativeToolCandidates(envWith(), "linux", () => NON_WSL_PROC_VERSION)).toEqual([]);
  });

  it("nativeToolCandidates matches environment + platform", () => {
    expect(nativeToolCandidates(envWith({ WSL_DISTRO_NAME: "Ubuntu" }), "linux").map((c) => c.id)).toEqual(["clip"]);
    expect(nativeToolCandidates(envWith(), "win32").map((c) => c.id)).toEqual(["clip"]);
    expect(nativeToolCandidates(envWith(), "darwin").map((c) => c.id)).toEqual(["pbcopy"]);
    expect(nativeToolCandidates(envWith({ WAYLAND_DISPLAY: "wayland-0" }), "linux", () => NON_WSL_PROC_VERSION).map((c) => c.id)).toEqual(["wl-copy"]);
    expect(nativeToolCandidates(envWith({ DISPLAY: ":0" }), "linux", () => NON_WSL_PROC_VERSION).map((c) => c.id)).toEqual(["xclip", "xsel"]);
    expect(nativeToolCandidates(envWith(LINUX_DISPLAY), "linux", () => NON_WSL_PROC_VERSION).map((c) => c.id)).toEqual(["wl-copy", "xclip", "xsel"]);
    expect(nativeToolCandidates(envWith(), "linux", () => NON_WSL_PROC_VERSION)).toEqual([]);
    expect(nativeToolCandidates(envWith({ SSH_CONNECTION: "a b c d" }), "linux")).toEqual([]);
    expect(nativeToolCandidates(envWith(), "freebsd")).toEqual([]);
  });
});

describe("default tool lookup", () => {
  it("resolves a binary that exists on PATH to its path", async () => {
    const found = await defaultToolLookup("bun");
    expect(typeof found).toBe("string");
    expect(found!.length).toBeGreaterThan(0);
  });

  it("returns null for a binary that does not exist", async () => {
    const missing = await defaultToolLookup("praana-definitely-not-a-real-binary-xyz");
    expect(missing).toBeNull();
  });
});

describe("in-flight copy guard", () => {
  it("a second copy while one is in flight is ignored and spawns nothing", async () => {
    const deferred = makeDeferredSpawn();
    const state = createCopyRunState();
    const settled: string[] = [];
    const deps = {
      spawn: deferred.spawnFn,
      env: envWith(LINUX_DISPLAY),
      platform: "linux",
      lookup: async (cmd: string) => cmd,
      readProcVersion: () => NON_WSL_PROC_VERSION,
    };

    const first = runGuardedCopy("one", deps, state, {
      onSettled: (_result, text) => settled.push(text),
    });
    expect(first.started).toBe(true);
    expect(state.inFlight).toBe(true);

    const second = runGuardedCopy("two", deps, state, {
      onSettled: (_result, text) => settled.push(text),
    });
    expect(second.started).toBe(false);
    // Let the async write reach the spawn so the close listener is registered.
    await new Promise((r) => setTimeout(r, 0));
    expect(deferred.calls).toHaveLength(1);

    deferred.close(0);
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toEqual(["one"]);
    expect(state.inFlight).toBe(false);
  });

  it("the guard releases in a finally, so a later copy starts", async () => {
    const deferred = makeDeferredSpawn();
    const state = createCopyRunState();
    const settled: string[] = [];
    const deps = {
      spawn: deferred.spawnFn,
      env: envWith(LINUX_DISPLAY),
      platform: "linux",
      lookup: async (cmd: string) => cmd,
      readProcVersion: () => NON_WSL_PROC_VERSION,
    };

    runGuardedCopy("one", deps, state, {
      onSettled: (_result, text) => settled.push(text),
    });
    await new Promise((r) => setTimeout(r, 0));
    deferred.close(0);
    await new Promise((r) => setTimeout(r, 5));

    const again = runGuardedCopy("three", deps, state, {
      onSettled: (_result, text) => settled.push(text),
    });
    expect(again.started).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(deferred.calls).toHaveLength(2);
    deferred.close(0);
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toEqual(["one", "three"]);
  });
});

describe("clipboard writer — lookup failures", () => {
  it("a lookup that throws is treated as a miss and falls through to OSC 52", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(LINUX_DISPLAY),
      platform: "linux",
      lookup: async () => {
        throw new Error("lookup boom");
      },
      readProcVersion: () => NON_WSL_PROC_VERSION,
      isOsc52Supported: () => true,
      osc52: () => true,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("osc52");
    expect(spawnState.calls).toHaveLength(0);
  });

  it("a lookup that throws on the first tool still tries the next tool", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(LINUX_DISPLAY),
      platform: "linux",
      lookup: async (cmd) => {
        if (cmd === "wl-copy") throw new Error("lookup boom");
        return cmd;
      },
      readProcVersion: () => NON_WSL_PROC_VERSION,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("xclip");
    expect(spawnState.calls.map((c) => c.command)).toEqual(["xclip"]);
  });
});

describe("WSL native candidates — Linux fallback", () => {
  it("WSL appends display-gated Linux candidates after clip.exe", () => {
    expect(
      nativeToolCandidates(
        envWith({ WSL_DISTRO_NAME: "Ubuntu", WAYLAND_DISPLAY: "wayland-0" }),
        "linux",
        () => NON_WSL_PROC_VERSION,
      ).map((c) => c.id),
    ).toEqual(["clip", "wl-copy"]);
    expect(
      nativeToolCandidates(
        envWith({ WSL_DISTRO_NAME: "Ubuntu", DISPLAY: ":0" }),
        "linux",
        () => NON_WSL_PROC_VERSION,
      ).map((c) => c.id),
    ).toEqual(["clip", "xclip", "xsel"]);
    expect(
      nativeToolCandidates(
        envWith({
          WSL_DISTRO_NAME: "Ubuntu",
          WAYLAND_DISPLAY: "wayland-0",
          DISPLAY: ":0",
        }),
        "linux",
        () => NON_WSL_PROC_VERSION,
      ).map((c) => c.id),
    ).toEqual(["clip", "wl-copy", "xclip", "xsel"]);
  });

  it("WSL without display-server env still prefers clip.exe alone", () => {
    expect(
      nativeToolCandidates(envWith({ WSL_DISTRO_NAME: "Ubuntu" }), "linux").map((c) => c.id),
    ).toEqual(["clip"]);
  });

  it("WSL falls back to wl-copy when clip.exe is missing (interop disabled)", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith({ WSL_DISTRO_NAME: "Ubuntu", WAYLAND_DISPLAY: "wayland-0" }),
      platform: "linux",
      lookup: async (cmd) => (cmd === "clip.exe" ? null : cmd),
      isOsc52Supported: () => false,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("wl-copy");
    expect(spawnState.calls.map((c) => c.command)).toEqual(["wl-copy"]);
  });

  it("WSL keeps clip.exe first when it is available", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith({ WSL_DISTRO_NAME: "Ubuntu", WAYLAND_DISPLAY: "wayland-0" }),
      platform: "linux",
      lookup: async (cmd) => cmd,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("clip");
    expect(spawnState.calls.map((c) => c.command)).toEqual(["clip.exe"]);
  });
});

describe("/proc/version caching", () => {
  it("memoizeReadProcVersion calls the underlying reader once", () => {
    let calls = 0;
    const read = memoizeReadProcVersion(() => {
      calls += 1;
      return "Linux version 6.1.90.1-microsoft-standard-WSL2";
    });
    expect(read()).toBe("Linux version 6.1.90.1-microsoft-standard-WSL2");
    expect(read()).toBe("Linux version 6.1.90.1-microsoft-standard-WSL2");
    expect(calls).toBe(1);
  });

  it("memoizeReadProcVersion caches null results too", () => {
    let calls = 0;
    const read = memoizeReadProcVersion(() => {
      calls += 1;
      return null;
    });
    expect(read()).toBeNull();
    expect(read()).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("copy guard — callback resilience", () => {
  const guardDeps = {
    spawn: () => {
      throw new Error("unused");
    },
    env: envWith(LINUX_DISPLAY),
    platform: "linux",
    lookup: async (cmd: string) => cmd,
    readProcVersion: () => NON_WSL_PROC_VERSION,
  };

  it("a throwing onStarted releases the guard and reports not-started", () => {
    const state = createCopyRunState();
    const first = runGuardedCopy("one", guardDeps, state, {
      onStarted: () => {
        throw new Error("onStarted boom");
      },
    });
    expect(first.started).toBe(false);
    expect(state.inFlight).toBe(false);

    // A later copy is not blocked.
    const deferred = makeDeferredSpawn();
    const second = runGuardedCopy("two", { ...guardDeps, spawn: deferred.spawnFn }, state);
    expect(second.started).toBe(true);
    expect(state.inFlight).toBe(true);
  });

  it("a throwing onSettled does not become an unhandled rejection and releases the guard", async () => {
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const deferred = makeDeferredSpawn();
      const state = createCopyRunState();
      runGuardedCopy("one", { ...guardDeps, spawn: deferred.spawnFn }, state, {
        onSettled: () => {
          throw new Error("onSettled boom");
        },
      });
      await new Promise((r) => setTimeout(r, 0));
      deferred.close(0);
      await new Promise((r) => setTimeout(r, 25));
      expect(unhandled).toBeNull();
      expect(state.inFlight).toBe(false);

      const again = runGuardedCopy("two", { ...guardDeps, spawn: deferred.spawnFn }, state);
      expect(again.started).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("overlay kind typing — reflects the real overlay state", () => {
  it("isModalOverlay and decideCtrlC accept every kind from the real overlay state", () => {
    const expected = new Map<OverlayKind, { modal: boolean; decision: unknown }>([
      ["none", { modal: false, decision: { action: "interrupt" } }],
      ["slash", { modal: false, decision: { action: "interrupt" } }],
      ["model", { modal: false, decision: { action: "cancel_overlay", overlay: "model" } }],
      ["login", { modal: true, decision: { action: "defer" } }],
      ["logout", { modal: true, decision: { action: "defer" } }],
      ["palette", { modal: false, decision: { action: "cancel_overlay", overlay: "palette" } }],
      ["setup", { modal: true, decision: { action: "defer" } }],
      ["consent", { modal: true, decision: { action: "defer" } }],
    ]);
    for (const [kind, { modal, decision }] of expected) {
      expect(isModalOverlay(kind)).toBe(modal);
      expect(decideCtrlC(false, "", kind)).toEqual(decision);
    }
  });

  // Compile-time guards: an overlay kind outside the shared union must be a
  // type error (enforced by tsc/IDEs; bun runs them as inert expressions).
  // @ts-expect-error non-modal overlay kinds are rejected at compile time
  isModalOverlay("bogus");
  // @ts-expect-error unknown overlay kinds are rejected at compile time
  decideCtrlC(false, "", "bogus");
});
