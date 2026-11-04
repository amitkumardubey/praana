import { describe, expect, it } from "bun:test";
import { ATOMIC_HABITS_MARKDOWN, STREAM_MARKDOWN } from "../scripts/tui-bounce/fixture.js";
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

const stable = (text: string) => stabilizeStreamingMarkdown(text, { withholdIncomplete: true });

describe("streaming syntax stabilization (opt-in)", () => {
  it("withholds unfinished strong, emphasis, underscore and code spans", () => {
    for (const marker of ["**", "*", "_", "__", "`", "``"]) {
      expect(stable(`Safe text ${marker}unfinished`)).toBe("Safe text");
      expect(stable(`Safe text ${marker}`)).toBe("Safe text");
    }
    expect(stable("sky\n- **Platea")).toBe("sky");
    expect(stable("Shift: **“I’m")).toBe("Shift:");
    expect(stable("Before **bold *nested")).toBe("Before");
    expect(stable("Before *italic **nested")).toBe("Before");
  });

  it("releases unmatched spans at paragraph and block boundaries", () => {
    for (const first of ["def f(*args, **kwargs)", "int *p", "src/**/*.ts", "stray `code", "stray _word"]) {
      expect(stable(`${first}\n\nLater paragraph`)).toBe(`${first}\n\nLater paragraph`);
    }
    for (const block of ["# Heading", "- item", "1. item", "> quote", "```ts\ncode\n```", "| a | b |\n| --- | --- |\n| c | d |"]) {
      const text = `int *p\n${block}`;
      expect(stable(text)).toBe(text);
    }
    expect(stable("Earlier paragraph\n\ndef f(*args, **kwargs)")).toBe("Earlier paragraph\n\ndef f(");
  });

  it("withholds lone marker lines, including their trailing newline", () => {
    for (const marker of ["**", "*", "_", "__", "`", "#", "##", "###"]) {
      expect(stable(`Safe text\n${marker}\n`)).toBe("Safe text");
    }
  });

  it("releases balanced and nested spans without changing their bytes", () => {
    for (const text of [
      "**Goals** define results", "Use *small steps* and _repeat_", "Use __strong__ text",
      "**bold *nested***", "***bold** italic*", "***both***", "*italic **nested***",
      "Use `**literal**` code", "Use ``a ` b`` code", "**multi\nline**", "`multiline\n`",
      "snake_case and long_variable_name", "2 * 3 = 6", "Escaped \\*literal and \\_literal and \\`literal",
    ]) expect(stable(text)).toBe(text);
    expect(stable(ATOMIC_HABITS_MARKDOWN)).toBe(ATOMIC_HABITS_MARKDOWN);
    expect(stable(STREAM_MARKDOWN)).toBe(STREAM_MARKDOWN);
  });

  it("does not rewrite code fences or the markers inside them", () => {
    for (const text of [
      "```ts\nconst x = '**_`';\n- ",
      "~~~md\n**unfinished\n| partial\n~~~",
      "````md\n```\n**unfinished\n````",
    ]) expect(stable(text)).toBe(text);
  });

  it("holds table headers/separators until all columns are known", () => {
    const header = "| Habit | Version |";
    const rule = "| --- | --- |";
    for (const tail of [header, `${header}\n`, `${header}\n| --- |`, `${header}\n| --- | ---`]) {
      expect(stable(`Safe text\n\n${tail}`)).toBe("Safe text");
    }
    // OpenTUI falls back to raw CodeRenderable for a header-only table.
    expect(stable(`${header}\n${rule}`)).toBe("");
    expect(stable(`${header}\n${rule}\n| Read books | Read`)).toBe("");
    const complete = `${header}\n${rule}\n| Read books | Read one page |`;
    expect(stable(complete)).toBe(complete);
    expect(stable(`${complete}\n| Run | Put on`)).toBe(complete);
    expect(stable(`${complete}\n| Run | **Put on |`)).toBe(complete);
    expect(stable(`${header}\n${rule}\n| Read | **Read |`)).toBe("");
  });
});
