import { describe, expect, it } from "bun:test";
import { createTerminalCapabilities, createTestRenderer, setRendererCapabilities } from "@opentui/core/testing";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { render } from "@opentui/solid";
import { createComponent } from "solid-js";
import { MarkdownRenderable } from "@opentui/core";
import { buildMarkdownSyntaxStyle, releaseMarkdownSyntaxStyles } from "../src/ui/tui/transcript/markdown-theme.js";
import { RetainedMarkdownRenderable } from "../src/ui/tui/transcript/retained-markdown.js";
import { createTranscriptStore } from "../src/ui/tui/transcript/store.js";
import { TranscriptView } from "../src/ui/tui/transcript/view.js";

describe("transcript capability listeners", () => {
  it("shares one listener across thirty entries and unregisters them on removal", async () => {
    const setup = await createTestRenderer({ width: 80, height: 40 });
    // Pin the starting capabilities: terminal detection depends on the environment,
    // and the refresh rule only fires when the hyperlink capability actually changes.
    setRendererCapabilities(setup.renderer, createTerminalCapabilities({ hyperlinks: false }));
    const store = createTranscriptStore();
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    // OpenTUI itself also lazily installs one shared markdown listener.
    const sentinel = new MarkdownRenderable(setup.renderer, { syntaxStyle: buildMarkdownSyntaxStyle(setup.renderer.nativeScene), content: "" });
    setup.renderer.root.add(sentinel);
    try {
      await render(() => createComponent(KeymapProvider, {
        keymap,
        children: () => createComponent(TranscriptView, {
          store, opts: { markdownRendering: true, syntaxTheme: "default", backgroundZones: false, useUnicode: true },
        }),
      }), setup.renderer);
      await setup.renderOnce();
      const baseline = setup.renderer.listenerCount("capabilities");
      for (let i = 0; i < 30; i++) {
        store.mount.appendEntry({ id: `a${i}`, role: "assistant", group: i, text: `[link ${i}](https://example.com)` });
      }
      await setup.renderOnce();
      const instances: RetainedMarkdownRenderable[] = [];
      const visit = (node: any) => {
        if (node instanceof RetainedMarkdownRenderable) instances.push(node);
        for (const child of node.getChildren()) visit(child);
      };
      visit(setup.renderer.root);
      expect(instances.length).toBe(30);
      expect(setup.renderer.listenerCount("capabilities")).toBeLessThanOrEqual(baseline + 1);
      const refreshed = new Map<RetainedMarkdownRenderable, number>();
      for (const instance of instances) {
        const original = instance.refreshStyles.bind(instance);
        instance.refreshStyles = () => { refreshed.set(instance, (refreshed.get(instance) ?? 0) + 1); original(); };
      }
      for (const hyperlinks of [true, false]) {
        const capabilities = setRendererCapabilities(setup.renderer, createTerminalCapabilities({ hyperlinks }));
        setup.renderer.emit("capabilities", capabilities);
      }
      for (const instance of instances) expect(refreshed.get(instance)).toBe(2);
      store.clear();
      await setup.renderOnce();
      expect(setup.renderer.listenerCount("capabilities")).toBe(baseline);
      const capabilities = setRendererCapabilities(setup.renderer, createTerminalCapabilities({ hyperlinks: true }));
      setup.renderer.emit("capabilities", capabilities);
      for (const instance of instances) expect(refreshed.get(instance)).toBe(2);
    } finally {
      store.dispose();
      await setup.dispose();
      releaseMarkdownSyntaxStyles(setup.renderer.nativeScene);
    }
  });
});
