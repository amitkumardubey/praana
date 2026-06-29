import { describe, it, expect } from "bun:test";
import {
  createTestBackendState,
  createTestBackend,
  createTerminal,
  terminalDrawBuffer,
  paragraph,
  block,
  lengthConstraint,
  fillConstraint,
  createLayout,
  splitLayout,
  createRect,
  testBackendToString,
} from "../../src/terminal/index.js";
import { renderWidget } from "../../src/terminal/widgets/widget.js";

describe("widgets snapshot", () => {
  it("should render bordered paragraph", () => {
    const state = createTestBackendState(40, 6);
    const terminal = createTerminal(createTestBackend(state));

    terminalDrawBuffer(terminal, (frame) => {
      const widget = paragraph({
        text: "Hello, terminal!",
        block: { border: "plain", title: "Greeting" },
      });
      renderWidget(widget, frame.area, frame.buffer);
    });

    const output = testBackendToString(state);
    expect(output).toContain("Greeting");
    expect(output).toContain("Hello, terminal!");
    expect(output).toMatch(/┌/);
  });

  it("should render layout split with block and paragraph", () => {
    const state = createTestBackendState(50, 8);
    const terminal = createTerminal(createTestBackend(state));

    terminalDrawBuffer(terminal, (frame) => {
      const layout = createLayout([
        lengthConstraint(3),
        fillConstraint(1),
      ]);
      const [header, body] = splitLayout(layout, frame.area);
      block({ border: "plain", title: "Header" }).render(header, frame.buffer);
      paragraph({ text: "Body content here" }).render(body, frame.buffer);
    });

    const output = testBackendToString(state);
    expect(output).toContain("Header");
    expect(output).toContain("Body content here");
  });
});
