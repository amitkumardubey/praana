import { describe, expect, it } from "bun:test";
import { STREAM_MARKDOWN } from "../scripts/tui-bounce/fixture.js";
import { stabilizeStreamingMarkdown } from "../src/ui/tui/transcript/streaming-markdown.js";

describe("stabilizeStreamingMarkdown", () => {
  it("leaves a finished answer unchanged", () => {
    expect(stabilizeStreamingMarkdown(STREAM_MARKDOWN)).toBe(STREAM_MARKDOWN);
  });

  it("drops a bare list marker and a trailing item space", () => {
    expect(stabilizeStreamingMarkdown("sky\n- ")).toBe("sky");
    expect(stabilizeStreamingMarkdown("sky\n- \n")).toBe("sky");
    expect(stabilizeStreamingMarkdown("sky\n-")).toBe("sky");
    expect(stabilizeStreamingMarkdown("- **Rayleigh** daytime ")).toBe("- **Rayleigh** daytime");
    expect(stabilizeStreamingMarkdown("1. Measure ")).toBe("1. Measure");
    expect(stabilizeStreamingMarkdown("sky\n- **Platea")).toBe("sky\n- **Platea");
    expect(stabilizeStreamingMarkdown("# Title\n\n")).toBe("# Title");
    expect(stabilizeStreamingMarkdown("- **Mie** haze around the sun\n")).toBe(
      "- **Mie** haze around the sun",
    );
  });

  it("does not rewrite an open code fence", () => {
    const open = "```ts\nconst x = 1;\n- ";
    expect(stabilizeStreamingMarkdown(open)).toBe(open);
  });

  it("keeps a paragraph's trailing space", () => {
    expect(stabilizeStreamingMarkdown("Hello world ")).toBe("Hello world ");
  });
});
