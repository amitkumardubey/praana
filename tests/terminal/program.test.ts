import { describe, it, expect } from "bun:test";
import { none, quit, batch, runCmd, task } from "../../src/terminal/runtime/cmd.js";
import { renderProgramFrame, type Program } from "../../src/terminal/runtime/program.js";
import { view } from "../../src/terminal/runtime/view.js";
import {
  createTestBackendState,
  createTestBackend,
  createTerminal,
  testBackendToString,
} from "../../src/terminal/index.js";
import { renderWidget } from "../../src/terminal/widgets/widget.js";
import { paragraph } from "../../src/terminal/widgets/paragraph.js";

interface HelloModel {
  message: string;
}

type HelloMsg = { type: "quit" };

const helloProgram: Program<HelloModel, HelloMsg> = {
  init() {
    return [{ message: "Hello, terminal!" }, none()];
  },
  update(model, msg) {
    if (msg.type === "quit") return [model, quit()];
    return [model, none()];
  },
  view(model) {
    return view((frame) => {
      renderWidget(
        paragraph({
          text: model.message,
          block: { border: "plain", title: "Demo" },
        }),
        frame.area,
        frame.buffer
      );
    });
  },
};

describe("runCmd", () => {
  it("should stop on quit", async () => {
    const cont = await runCmd(quit(), () => {});
    expect(cont).toBe(false);
  });

  it("should run batch", async () => {
    let count = 0;
    await runCmd(
      batch([none(), task(() => { count++; })]),
      () => {}
    );
    expect(count).toBe(1);
  });
});

describe("renderProgramFrame", () => {
  it("should render hello program", () => {
    const state = createTestBackendState(40, 6);
    const terminal = createTerminal(createTestBackend(state));
    renderProgramFrame(helloProgram, { message: "Hello, terminal!" }, terminal);
    const out = testBackendToString(state);
    expect(out).toContain("Hello, terminal!");
    expect(out).toContain("Demo");
  });
});
