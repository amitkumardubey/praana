import { expect, test } from "bun:test";
import {
  buildCaptureCommand,
  buildCaptureHeader,
  capture,
  collectEnvArgs,
  parseSize,
  turnFinished,
} from "../scripts/tui-probe/capture";

test("capture rejects an invalid timeout before launching tmux", async () => {
  await expect(capture(".", "test", "110x40", 0)).rejects.toThrow("Invalid timeout");
});

test("capture accepts positive terminal dimensions", () => {
  expect(parseSize("80x24")).toEqual({ width: 80, height: 24 });
  expect(() => parseSize("80x0")).toThrow();
});

test("capture only finishes after a busy turn returns to idle", () => {
  expect(turnFinished(false, "replying…")).toEqual({ busy: true, finished: false });
  expect(turnFinished(false, "idle")).toEqual({ busy: false, finished: false });
  expect(turnFinished(true, "idle")).toEqual({ busy: true, finished: false });
  expect(turnFinished(true, "Message Praana")).toEqual({ busy: true, finished: true });
});

test("buildCaptureCommand constructs valid tmux env list without extra env", () => {
  const cmd = buildCaptureCommand("/tmp/worktree", "/tmp/isolated", "/home/user");
  expect(cmd).toContain("exec env -i");
  expect(cmd).toContain("PRAANA_NO_UPDATE_CHECK=1");
  expect(cmd).toContain("OPENAI_API_KEY=sk-mock");
  expect(cmd).toContain("bun src/main.ts");
});

test("buildCaptureCommand safely quotes env values with spaces and single quotes", () => {
  const cmd = buildCaptureCommand("/tmp/worktree", "/tmp/isolated", "/home/user", [
    "PRAANA_TUI_STREAM_BATCH_MS=33",
    "CUSTOM_VAL=hello 'world'",
  ]);
  expect(cmd).toContain("'PRAANA_TUI_STREAM_BATCH_MS=33'");
  expect(cmd).toContain("'CUSTOM_VAL=hello '\\''world'\\'''");
});

test("buildCaptureCommand rejects invalid env entries without equals sign", () => {
  expect(() =>
    buildCaptureCommand("/tmp/worktree", "/tmp/isolated", "/home/user", ["INVALID_ENV"]),
  ).toThrow("Invalid env format");
});

test("buildCaptureHeader omits env when none is given", () => {
  const header = buildCaptureHeader("test-label", "110x40", "deadbeef", 95.5);
  expect(header).toEqual({
    type: "header",
    label: "test-label",
    size: "110x40",
    commit: "deadbeef",
    achievedHz: 95.5,
  });
  expect("env" in header).toBe(false);
});

test("buildCaptureHeader includes env array when provided", () => {
  const header = buildCaptureHeader("test-label", "110x40", "deadbeef", 95.5, [
    "PRAANA_TUI_STREAM_BATCH_MS=33",
  ]);
  expect(header.env).toEqual(["PRAANA_TUI_STREAM_BATCH_MS=33"]);
});

test("collectEnvArgs gathers repeatable flags and rejects missing values", () => {
  const args = ["--worktree", ".", "--env", "A=1", "--size", "80x24", "--env", "B=2"];
  expect(collectEnvArgs(args, "--env")).toEqual(["A=1", "B=2"]);
  expect(() => collectEnvArgs(["--env"], "--env")).toThrow("Missing value");
  expect(() => collectEnvArgs(["--env", "--other"], "--env")).toThrow("Missing value");
});
