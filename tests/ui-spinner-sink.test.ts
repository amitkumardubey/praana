import { describe, it, expect, afterEach } from "bun:test";
import { setSpinnerSink, startSpinner, stopSpinner } from "../src/ui.js";

describe("setSpinnerSink", () => {
  afterEach(() => {
    setSpinnerSink();
  });

  it("routes startSpinner and stopSpinner through the sink", () => {
    const calls: string[] = [];
    setSpinnerSink({
      start: (text) => calls.push(`start:${text}`),
      stop: () => calls.push("stop"),
    });

    startSpinner("Loading embedding model…");
    startSpinner("Loading embedding model (42%)…");
    stopSpinner();

    expect(calls).toEqual([
      "start:Loading embedding model…",
      "start:Loading embedding model (42%)…",
      "stop",
    ]);
  });

  it("restores the ora/TTY path after the sink is cleared", () => {
    const calls: string[] = [];
    setSpinnerSink({
      start: (text) => calls.push(`start:${text}`),
      stop: () => calls.push("stop"),
    });
    startSpinner("via sink");
    setSpinnerSink();
    startSpinner("after clear");
    stopSpinner();

    expect(calls).toEqual(["start:via sink"]);
  });
});
