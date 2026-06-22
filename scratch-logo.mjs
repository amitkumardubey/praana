import chalk from "chalk";

const CREAM = "#ECEFF4";  // nord6
const GREEN = "#A3BE8C";  // nord14 sage
const MUTED = "#D8DEE9";  // nord4
const RULE = "#4C566A";

const cream = (s) => chalk.hex(CREAM)(s);
const green = (s) => chalk.hex(GREEN)(s);
const muted = (s) => chalk.hex(MUTED)(s);
const header = (l) =>
  chalk.hex(RULE)(`\n  ── ${l} ${"─".repeat(Math.max(0, 42 - l.length))}\n`);

const TAG = "ADAPTIVE CONTEXT · COGNITIVE MEMORY · AGENT RUNTIME";

// ---- lowercase "praana" wordmark attempts ----

// W1 — half-block lowercase, 3 rows (p faked descender on row 3)
const W1 = [
  "█▀█ █▀▄ ▄▀█ ▄▀█ █▄ █ ▄▀█",
  "█▀▀ █   █▀█ █▀█ █ ██ █▀█",
  "█                       ",
];

// W2 — rounded thin lowercase, 3 rows
const W2 = [
  "╭─╮ ╭─╮ ╭─╮ ╭─╮ ╭╮╷ ╭─╮",
  "├─┘ ├┬╴ ├─┤ ├─┤ │╰┤ ├─┤",
  "╵                      ",
];

// W3 — wide spaced caps-style lowercase (mono feel)
const W3 = [
  "┌─┐ ┌─┐ ┌─┐ ┌─┐ ┌┐╷ ┌─┐",
  "├─┘ ├┬┘ ├─┤ ├─┤ │└┤ ├─┤",
  "┴                      ",
];

function show(label, word, withMono) {
  console.log(header(label));
  if (withMono) {
    // tiny pn line monogram with trailing fade dots
    console.log(cream("    ╭─╮") + green("  ╭─◌"));
    console.log(cream("    │ │") + green("  │"));
    console.log(cream("    ╰─┤") + green("  ╵"));
    console.log(cream("      ╵") + green("   ◌"));
    console.log(green("          ·"));
    console.log();
  }
  word.forEach((l) => console.log(cream(l)));
  console.log();
  console.log(green(">_ ") + green(TAG));
  console.log();
}

show("W1  half-block wordmark", W1, false);
show("W2  rounded thin wordmark", W2, false);
show("W3  box wordmark", W3, false);
show("W2 + monogram", W2, true);

// alt tagline color: prompt green, text muted
console.log(header("tagline color variants"));
console.log(green(">_ ") + green(TAG));
console.log(green(">_ ") + muted(TAG));
console.log(green(">_ ") + muted("Adaptive Context · Cognitive Memory · Agent Runtime"));
console.log();
