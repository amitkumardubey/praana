import { describe, it, expect } from "bun:test";
import {
  detectPlanApproval,
  isBranchCreatingShellCommand,
  isPlanModeMutatingTool,
} from "../src/plan-mode.js";

describe("detectPlanApproval", () => {
  it("approves on bare approval words", () => {
    expect(detectPlanApproval("go")).toBe(true);
    expect(detectPlanApproval("execute")).toBe(true);
    expect(detectPlanApproval("proceed")).toBe(true);
    expect(detectPlanApproval("continue")).toBe(true);
  });

  it("approves on explicit plan-approval phrases", () => {
    expect(detectPlanApproval("go ahead")).toBe(true);
    expect(detectPlanApproval("execute the plan")).toBe(true);
    expect(detectPlanApproval("proceed with the plan")).toBe(true);
    expect(detectPlanApproval("continue with implementation")).toBe(true);
    expect(detectPlanApproval("let's execute it")).toBe(true);
  });

  it("does not approve on deferral phrases", () => {
    expect(detectPlanApproval("go back")).toBe(false);
    expect(detectPlanApproval("continue reading")).toBe(false);
    expect(detectPlanApproval("continue reading the file")).toBe(false);
    expect(detectPlanApproval("execute a search")).toBe(false);
    expect(detectPlanApproval("execute the search")).toBe(false);
    expect(detectPlanApproval("proceed carefully")).toBe(false);
    expect(detectPlanApproval("continue to plan")).toBe(false);
    expect(detectPlanApproval("continue later")).toBe(false);
    expect(detectPlanApproval("go to the file")).toBe(false);
    expect(detectPlanApproval("execute after reviewing")).toBe(false);
  });
});

describe("isBranchCreatingShellCommand", () => {
  it("matches branch creation commands", () => {
    expect(isBranchCreatingShellCommand("git branch feature")).toBe(true);
    expect(isBranchCreatingShellCommand("git branch feature main")).toBe(true);
    expect(isBranchCreatingShellCommand("git branch -c old new")).toBe(true);
    expect(isBranchCreatingShellCommand("git branch -C old new")).toBe(true);
    expect(isBranchCreatingShellCommand("git checkout -b feature")).toBe(true);
    expect(isBranchCreatingShellCommand("git checkout -B feature")).toBe(true);
    expect(isBranchCreatingShellCommand("git switch -c feature")).toBe(true);
    expect(isBranchCreatingShellCommand("git switch -C feature")).toBe(true);
  });

  it("does not match list, delete, rename, or checkout-only commands", () => {
    expect(isBranchCreatingShellCommand("git branch")).toBe(false);
    expect(isBranchCreatingShellCommand("git branch -a")).toBe(false);
    expect(isBranchCreatingShellCommand("git branch -v")).toBe(false);
    expect(isBranchCreatingShellCommand("git branch --list")).toBe(false);
    expect(isBranchCreatingShellCommand("git branch -d feature")).toBe(false);
    expect(isBranchCreatingShellCommand("git branch -D feature")).toBe(false);
    expect(isBranchCreatingShellCommand("git branch -m old new")).toBe(false);
    expect(isBranchCreatingShellCommand("git branch -M old new")).toBe(false);
    expect(isBranchCreatingShellCommand("git checkout feature")).toBe(false);
    expect(isBranchCreatingShellCommand("git checkout main")).toBe(false);
    expect(isBranchCreatingShellCommand("git switch feature")).toBe(false);
  });
});

describe("isPlanModeMutatingTool", () => {
  it("blocks file-mutating tools", () => {
    expect(isPlanModeMutatingTool("edit_file", {})).toBe(true);
    expect(isPlanModeMutatingTool("write_file", {})).toBe(true);
    expect(isPlanModeMutatingTool("batch_edit", {})).toBe(true);
    expect(isPlanModeMutatingTool("batch_write", {})).toBe(true);
    expect(isPlanModeMutatingTool("git_commit", { message: "feat: x" })).toBe(true);
  });

  it("blocks shell branch-creation commands", () => {
    expect(
      isPlanModeMutatingTool("shell", { command: "git checkout -b feature" }),
    ).toBe(true);
    expect(
      isPlanModeMutatingTool("shell", { command: "git switch -c feature" }),
    ).toBe(true);
  });

  it("allows read-only tools", () => {
    expect(isPlanModeMutatingTool("read_file", { path: "a.txt" })).toBe(false);
    expect(isPlanModeMutatingTool("search_code", { query: "foo" })).toBe(false);
    expect(isPlanModeMutatingTool("recall", { query: "foo" })).toBe(false);
    expect(isPlanModeMutatingTool("git_status", {})).toBe(false);
    expect(isPlanModeMutatingTool("git_diff", { staged: true })).toBe(false);
  });

  it("allows non-branch shell commands", () => {
    expect(
      isPlanModeMutatingTool("shell", { command: "git branch -a" }),
    ).toBe(false);
    expect(
      isPlanModeMutatingTool("shell", { command: "git status" }),
    ).toBe(false);
  });
});
