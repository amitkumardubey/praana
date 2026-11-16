import { describe, it, expect } from "bun:test";
import { toolResultIsError } from "../src/tool-result-error.js";

describe("toolResultIsError", () => {
  it("treats ok:false as an error", () => {
    expect(toolResultIsError("edit_file", { ok: false, error: "Edit cancelled by user" })).toBe(true);
    expect(toolResultIsError("shell", { ok: false, stdout: "", stderr: "", exitCode: 1 })).toBe(true);
    expect(toolResultIsError("shell", { ok: false, stderr: "Interrupted", exitCode: 130 })).toBe(true);
  });

  it("does not treat ok:true or non-objects as errors", () => {
    expect(toolResultIsError("edit_file", { ok: true })).toBe(false);
    expect(toolResultIsError("shell", "text")).toBe(false);
    expect(toolResultIsError("shell", null)).toBe(false);
    expect(toolResultIsError("x", { content: "no ok field" })).toBe(false);
  });

  it("exempts run_tests that ran and failed, but not run_tests errors", () => {
    expect(toolResultIsError("run_tests", { ok: false, failed: 2, failures: [] })).toBe(false);
    expect(toolResultIsError("run_tests", { ok: false, error: "spawn", code: "spawn_error" })).toBe(true);
  });
});
