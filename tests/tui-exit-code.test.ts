/**
 * Exit-code decision for the TUI. A session at shutdown exits 0. With no
 * session, exit 1 only when setup was cancelled, failed, pending, or
 * succeeded but the session never started; otherwise exit 0.
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

  it("exits 1 when setup succeeded but the session never came up", () => {
    expect(
      resolveShutdownExitCode({ setupOutcome: "completed", hasSession: false }),
    ).toBe(1);
  });

  it("exits 1 when the session failed to start after setup", () => {
    expect(
      resolveShutdownExitCode({ setupOutcome: "start-failed", hasSession: false }),
    ).toBe(1);
  });

  it("exits 0 when setup was not needed and there is no session", () => {
    expect(
      resolveShutdownExitCode({ setupOutcome: "not-needed", hasSession: false }),
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
