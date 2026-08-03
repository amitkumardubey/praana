import { describe, it, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { UserMessageComponent } from "../src/ui/tui/transcript/components/user-message.js";
import { AssistantMessageComponent } from "../src/ui/tui/transcript/components/assistant-message.js";
import { SystemLineComponent } from "../src/ui/tui/transcript/components/system-line.js";
import { TurnFooterComponent } from "../src/ui/tui/transcript/components/turn-footer.js";
import { ToolRowComponent } from "../src/ui/tui/transcript/components/tool-row.js";
import { ThinkingMessageComponent } from "../src/ui/tui/transcript/components/thinking-message.js";
import { RecallChipComponent } from "../src/ui/tui/transcript/components/recall-chip.js";
import { buildMarkdownSyntaxStyle } from "../src/ui/tui/transcript/markdown-theme.js";
import type { TranscriptRenderOpts } from "../src/ui/tui/transcript/opts.js";

const opts: TranscriptRenderOpts = {
  markdownRendering: true,
  syntaxTheme: "default",
  backgroundZones: false,
  useUnicode: true,
};

const plainOpts: TranscriptRenderOpts = {
  markdownRendering: false,
  syntaxTheme: "default",
  backgroundZones: false,
  useUnicode: true,
};

const mdStyle = buildMarkdownSyntaxStyle("default");

describe("UserMessageComponent", () => {
  it("renders the user text", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const c = new UserMessageComponent(setup.renderer, "hello there", opts);
      setup.renderer.root.add(c);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("hello there");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("AssistantMessageComponent", () => {
  it("renders plain (non-markdown) text", async () => {
    const setup = await createTestRenderer({ width: 40, height: 20 });
    try {
      const c = new AssistantMessageComponent(setup.renderer, "plain text here", plainOpts);
      setup.renderer.root.add(c);
      await setup.renderOnce();
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("plain text here");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("setText updates plain text content", async () => {
    const setup = await createTestRenderer({ width: 40, height: 20 });
    try {
      const c = new AssistantMessageComponent(setup.renderer, "first", plainOpts);
      setup.renderer.root.add(c);
      await setup.renderOnce();
      await setup.flush();
      c.setText("second");
      await setup.renderOnce();
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("second");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("constructs a markdown SyntaxStyle without throwing", () => {
    expect(mdStyle).toBeDefined();
  });
});

describe("SystemLineComponent", () => {
  it("prefixes error icon for error text", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const c = new SystemLineComponent(setup.renderer, "Error: something broke", opts);
      setup.renderer.root.add(c);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("something broke");
      expect(frame).toContain("✕");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("TurnFooterComponent", () => {
  it("renders dim digest text", async () => {
    const setup = await createTestRenderer({ width: 40, height: 3 });
    try {
      const c = new TurnFooterComponent(setup.renderer, "3 tools · 1.2k tok");
      setup.renderer.root.add(c);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("3 tools");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("ThinkingMessageComponent", () => {
  it("renders the thinking header", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const c = new ThinkingMessageComponent(setup.renderer, "chain of thought here", opts);
      setup.renderer.root.add(c);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("thinking");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("RecallChipComponent", () => {
  it("renders the recall count", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const c = new RecallChipComponent(setup.renderer, "preview text", 3, "query x", opts);
      setup.renderer.root.add(c);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("recall 3");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("ToolRowComponent", () => {
  it("renders the tool name and pending state", async () => {
    const setup = await createTestRenderer({ width: 50, height: 5 });
    try {
      const c = new ToolRowComponent(
        setup.renderer,
        {
          toolName: "read_file",
          toolIcon: "📄",
          toolLabel: "read_file",
          toolPending: "(…)",
        },
        opts,
      );
      setup.renderer.root.add(c);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("read_file");
    } finally {
      setup.renderer.destroy();
    }
  });
});
