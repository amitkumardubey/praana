/**
 * Exit-code decision for the TUI: a normal exit after a successful first-run
 * setup exits 0; 1 is reserved for setup cancelled/failed before a session
 * existed.
 */
import { describe, expect, it } from "bun:test";
import { resolveShutdownExitCode } from "../src/ui/tui/run.js";

describe("resolveShutdownExitCode", () => {
  it("exits 0 for /exit after a successful first-run setup", () => {
    expect(
      resolveShutdownExitCode({ setupOutcome: "completed", hasSession: true }),
    ).toBe(0);
  });

  it("exits 0 for a normal session (no setup involved)", () => {
    expect(
      resolveShutdownExitCode({ setupOutcome: "not-needed", hasSession: true }),
    ).toBe(0);
  });

  it("exits 0 when setup succeeded even if the session never came up", () => {
    expect(
      resolveShutdownExitCode({ setupOutcome: "completed", hasSession: false }),
    ).toBe(0);
  });

  it("exits 1 when the setup wizard was cancelled before a session", () => {
    expect(
      resolveShutdownExitCode({ setupOutcome: "cancelled", hasSession: false }),
    ).toBe(1);
  });

  it("exits 1 when setup failed before a session", () => {
    expect(
      resolveShutdownExitCode({ setupOutcome: "failed", hasSession: false }),
    ).toBe(1);
  });

  it("exits 1 when setup never completed before a session", () => {
    expect(
      resolveShutdownExitCode({ setupOutcome: "pending", hasSession: false }),
    ).toBe(1);
  });

  it("exits 0 when a session exists despite an earlier cancel", () => {
    expect(
      resolveShutdownExitCode({ setupOutcome: "cancelled", hasSession: true }),
    ).toBe(0);
  });
});
