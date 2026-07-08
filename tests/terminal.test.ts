import { describe, it, expect } from "bun:test";
import * as readline from "node:readline";
import { isInteractiveTerminal, askQuestion } from "../src/terminal.js";

describe("terminal helpers", () => {
  it("isInteractiveTerminal reflects stdin/stdout TTY state", () => {
    const expected = !!(process.stdin.isTTY && process.stdout.isTTY);
    expect(isInteractiveTerminal()).toBe(expected);
  });

  it("askQuestion resolves with the trimmed user answer", async () => {
    const input = new (require("node:stream").PassThrough)();
    const output = new (require("node:stream").PassThrough)();
    const rl = readline.createInterface({ input, output });

    try {
      const askPromise = askQuestion(rl, "prompt: ");
      input.write("  hello world  \n");
      const answer = await askPromise;
      expect(answer).toBe("hello world");
    } finally {
      rl.close();
    }
  });
});
