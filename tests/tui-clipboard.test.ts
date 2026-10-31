/**
 * Unit tests for the TUI clipboard writer (`src/ui/tui/clipboard.ts`) and the
 * pure Ctrl+C decision helper.
 *
 * Coverage: method selection per environment (WSL, macOS, Linux Wayland / X11,
 * SSH, Windows), UTF-16LE+BOM bytes for clip.exe, tool-failure fallback,
 * total-failure result when no tool and OSC 52 are available, "text never in
 * argv", timeout handling, and the selection→copy vs empty-selection→interrupt
 * decision.
 */
import { describe, expect, it } from "bun:test";
import {
  decideCtrlC,
  isSshEnv,
  nativeToolCandidates,
  utf16leWithBom,
  writeClipboardText,
  type SpawnedProcess,
} from "../src/ui/tui/clipboard.js";

type FakeExitMode = "ok" | "fail" | "spawn-error" | "timeout";

interface FakeSpawnCall {
  command: string;
  args: readonly string[];
  stdinBytes: Uint8Array;
}

function makeFakeSpawn(modes: FakeExitMode[]) {
  const calls: FakeSpawnCall[] = [];
  let index = 0;
  const spawnFn = (
    command: string,
    args: readonly string[],
    _opts?: unknown,
  ): SpawnedProcess => {
    const call: FakeSpawnCall = { command, args, stdinBytes: new Uint8Array() };
    calls.push(call);
    const mode = modes[Math.min(index, modes.length - 1)] ?? "ok";
    index += 1;

    const stdin = {
      write(data: Uint8Array, cb?: () => void) {
        const next = new Uint8Array(call.stdinBytes.length + data.length);
        next.set(call.stdinBytes, 0);
        next.set(data, call.stdinBytes.length);
        call.stdinBytes = next;
        cb?.();
      },
      end() {},
      on(_ev: string, _cb: unknown) {},
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
      proc.listeners.close(mode === "fail" ? 1 : 0);
    });

    return proc;
  };
  return { spawnFn, calls };
}

function envWith(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { HOME: "/home/user", ...overrides };
}

function bytesOf(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

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
      env: envWith(),
      platform: "linux",
      lookup: async (cmd) => cmd,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("wl-copy");
    expect(spawnState.calls).toHaveLength(1);
    expect(spawnState.calls[0]!.command).toBe("wl-copy");
  });

  it("Linux X11 falls back to xclip", async () => {
    const spawnState = makeFakeSpawn(["fail", "ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(),
      platform: "linux",
      lookup: async (cmd) => cmd,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("xclip");
    expect(spawnState.calls.map((c) => c.command)).toEqual(["wl-copy", "xclip"]);
    expect(spawnState.calls[1]!.args).toEqual(["-selection", "clipboard"]);
  });

  it("Linux X11 falls back to xsel when xclip also fails", async () => {
    const spawnState = makeFakeSpawn(["fail", "fail", "ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(),
      platform: "linux",
      lookup: async (cmd) => cmd,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("xsel");
    expect(spawnState.calls.map((c) => c.command)).toEqual(["wl-copy", "xclip", "xsel"]);
    expect(spawnState.calls[2]!.args).toEqual(["--clipboard", "--input"]);
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
      env: envWith(),
      platform: "linux",
      lookup: async (cmd) => cmd,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("xclip");
  });

  it("a spawn error (ENOENT) falls through to the next option", async () => {
    const spawnState = makeFakeSpawn(["spawn-error", "ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(),
      platform: "linux",
      lookup: async (cmd) => cmd,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("xclip");
  });

  it("a lookup miss skips the tool entirely", async () => {
    const spawnState = makeFakeSpawn(["ok"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(),
      platform: "linux",
      lookup: async () => null,
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
      env: envWith(),
      platform: "linux",
      lookup: async (cmd) => cmd,
      timeoutMs: 20,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("xclip");
  }, 5000);

  it("native failure falls back to OSC 52 when supported", async () => {
    const spawnState = makeFakeSpawn(["fail"]);
    const result = await writeClipboardText("text", {
      spawn: spawnState.spawnFn,
      env: envWith(),
      platform: "linux",
      lookup: async (cmd) => cmd,
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

  it("empty selection → existing interrupt path", () => {
    expect(decideCtrlC(false, "")).toEqual({ action: "interrupt" });
  });

  it("selection present but text empty → existing interrupt path", () => {
    expect(decideCtrlC(true, "")).toEqual({ action: "interrupt" });
  });

  it("whitespace-only selection → existing interrupt path", () => {
    expect(decideCtrlC(true, "  \n\t ")).toEqual({ action: "interrupt" });
  });
});

describe("clipboard helpers — environment predicates and candidates", () => {
  it("isSshEnv detects SSH_CONNECTION and SSH_TTY", () => {
    expect(isSshEnv(envWith())).toBe(false);
    expect(isSshEnv(envWith({ SSH_CONNECTION: "x y z w" }))).toBe(true);
    expect(isSshEnv(envWith({ SSH_TTY: "/dev/pts/0" }))).toBe(true);
  });

  it("nativeToolCandidates matches environment + platform", () => {
    expect(nativeToolCandidates(envWith({ WSL_DISTRO_NAME: "Ubuntu" }), "linux").map((c) => c.id)).toEqual(["clip"]);
    expect(nativeToolCandidates(envWith(), "win32").map((c) => c.id)).toEqual(["clip"]);
    expect(nativeToolCandidates(envWith(), "darwin").map((c) => c.id)).toEqual(["pbcopy"]);
    expect(nativeToolCandidates(envWith(), "linux").map((c) => c.id)).toEqual(["wl-copy", "xclip", "xsel"]);
    expect(nativeToolCandidates(envWith({ SSH_CONNECTION: "a b c d" }), "linux")).toEqual([]);
    expect(nativeToolCandidates(envWith(), "freebsd")).toEqual([]);
  });
});
