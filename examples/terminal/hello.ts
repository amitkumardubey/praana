#!/usr/bin/env bun
/**
 * Hello-world alternate-screen demo.
 * Run: bun examples/terminal/hello.ts
 * Press q to quit.
 */
import {
  createAlternateTerminal,
  paragraph,
  renderWidget,
} from "../../src/terminal/index.js";
import { runProgram } from "../../src/terminal/runtime/program.js";
import { view } from "../../src/terminal/runtime/view.js";
import { none, quit } from "../../src/terminal/runtime/cmd.js";
import type { Program } from "../../src/terminal/runtime/program.js";
import type { KeyMsg } from "../../src/terminal/runtime/msg.js";
import { attachKeyListener as attachKeys } from "../../src/terminal/backend/stdin-keys.js";

interface Model {
  message: string;
}

type Msg = KeyMsg;

const program: Program<Model, Msg> = {
  init() {
    return [{ message: "Press q to quit" }, none()];
  },
  update(model, msg) {
    if (msg.type === "key" && (msg.input === "q" || msg.key.name === "q")) {
      return [model, quit()];
    }
    return [model, none()];
  },
  view(model) {
    return view(
      (frame) => {
        renderWidget(
          paragraph({
            text: model.message,
            block: { border: "rounded", title: "PRAANA Terminal" },
          }),
          frame.area,
          frame.buffer
        );
      },
      { alternateScreen: true }
    );
  },
};

const terminal = createAlternateTerminal();
await runProgram(program, terminal, {
  alternateScreen: true,
  onKey: (send) => attachKeys(send),
});
