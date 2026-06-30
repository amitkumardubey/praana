import { describe, it, expect, mock } from "bun:test";
import { PiTuiSink } from "../src/ui/tui/sink.js";
import type { TranscriptContainer } from "../src/ui/tui/transcript/container.js";
import type { ToastRegion } from "../src/ui/tui/toast-region.js";

describe("PiTuiSink", () => {
  it("disables shell live streaming so output stays in the transcript", () => {
    const sink = new PiTuiSink(
      { requestRender: mock() } as never,
      { appendAssistantDelta: mock() } as unknown as TranscriptContainer,
      { show: mock() } as unknown as ToastRegion,
      {
        ambient: "inline",
        showThinking: () => false,
        onSpinnerMessage: mock(),
        ctxWindowTokens: 128_000,
        ctxUsedTokens: () => 0,
      },
    );

    expect(sink.shellLiveStream).toBe(false);
  });
});
