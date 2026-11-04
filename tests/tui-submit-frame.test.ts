import { expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { waitForSubmittedFrame } from "../src/ui/tui/submit-frame.js";

it("requests a frame and starts the turn only after it is rendered", async () => {
  const events: string[] = [];
  class Renderer extends EventEmitter {
    requestRender() { events.push("request"); }
  }
  const renderer = new Renderer();
  events.push("append user", "start spinner");
  const turn = (async () => {
    await waitForSubmittedFrame(renderer);
    events.push("run turn");
  })();
  expect(events).toEqual(["append user", "start spinner", "request"]);
  renderer.emit("frame");
  await turn;
  expect(events).toEqual(["append user", "start spinner", "request", "run turn"]);
});
