import { expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { render } from "@opentui/solid";
import { createComponent, createSignal, Show } from "solid-js";
import { SlashResultOverlay } from "../src/ui/tui/overlays/slash-result.js";
import { createTranscriptStore } from "../src/ui/tui/transcript/store.js";
import { TranscriptView } from "../src/ui/tui/transcript/view.js";

it("keeps renderer listeners bounded through a long session and overlay cycles", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const store = createTranscriptStore();
  const keymap = createDefaultOpenTuiKeymap(setup.renderer);
  const [open, setOpen] = createSignal(false);
  const check = () => {
    for (const event of setup.renderer.eventNames()) {
      expect(setup.renderer.listenerCount(event)).toBeLessThan(10);
    }
  };
  try {
    await render(() => createComponent(KeymapProvider, {
      keymap,
      get children() {
        return [
          createComponent(TranscriptView, { store, opts: { markdownRendering: true, syntaxTheme: "default", backgroundZones: false, useUnicode: true } }),
          createComponent(Show, { get when() { return open(); }, get children() { return createComponent(SlashResultOverlay, { lines: ["result"] }); } }),
        ];
      },
    }), setup.renderer);
    for (let i = 0; i < 60; i++) {
      store.mount.appendEntry({ id: `a${i}`, role: "assistant", group: i, text: `answer ${i}` });
      check();
    }
    for (let i = 0; i < 20; i++) {
      setOpen(true);
      await setup.renderOnce();
      check();
      setOpen(false);
      await setup.renderOnce();
      check();
    }
    store.clear();
    check();
  } finally {
    store.dispose();
    await setup.dispose();
  }
});
