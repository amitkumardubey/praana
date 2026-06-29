#!/usr/bin/env bun
/**
 * Append-mode chat demo (scrollback + live region).
 * Run: bun examples/terminal/append-chat.ts
 */
import * as readline from "node:readline";
import {
  createAppendBackendState,
  createAppendBackend,
} from "../../src/terminal/backend/append.js";

const state = createAppendBackendState(process.stdout.columns ?? 80, 2);
const backend = createAppendBackend(state);

console.log("Append chat demo — type a message and press Enter (/exit to quit)\n");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "❯ ",
});

rl.prompt();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }
  if (trimmed === "/exit") {
    rl.close();
    return;
  }

  backend.appendLines([`You: ${trimmed}`]);
  backend.setLiveLines(["Assistant: thinking..."]);

  let dots = 0;
  const interval = setInterval(() => {
    dots = (dots + 1) % 4;
    backend.setLiveLines([`Assistant: thinking${".".repeat(dots)}`]);
  }, 300);

  setTimeout(() => {
    clearInterval(interval);
    backend.clearLive();
    backend.appendLines([`Assistant: Echo — ${trimmed}`]);
    rl.prompt();
  }, 1200);
});

rl.on("close", () => {
  console.log("\nBye.");
  process.exit(0);
});
