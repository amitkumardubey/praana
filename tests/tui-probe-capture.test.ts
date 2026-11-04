import { expect, test } from "bun:test";
import { capture, parseSize, turnFinished } from "../scripts/tui-probe/capture";

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
