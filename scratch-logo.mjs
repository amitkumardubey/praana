// PRAANA logo — line-art "pn" monogram (gap 1) + tagline.
// Cream p (nord6) + sage-green n (nord14) with trailing fade dots.
import chalk from "chalk";

const CREAM = "#ECEFF4"; // nord6
const GREEN = "#A3BE8C"; // nord14 sage
const MUTED = "#D8DEE9"; // nord4

const cream = (s) => chalk.hex(CREAM)(s);
const green = (s) => chalk.hex(GREEN)(s);
const muted = (s) => chalk.hex(MUTED)(s);

const TAG = "Adaptive Context · Cognitive Memory";
const TW = TAG.length; // 35

// p (cream) + gap 1 + n (green)
const P = ["╭──╮", "│  │", "├──╯", "│   ", "●   "];
const N = ["◌──╮", "   │", "   │", "   ◉", "   ◦"];
const GAP = " ";

const rows = P.map((p, i) => ({
  raw: p + GAP + (N[i] ?? ""),
  out: cream(p) + GAP + green(N[i] ?? ""),
}));
const width = Math.max(...rows.map((r) => [...r.raw].length));
const lead = " ".repeat(Math.max(0, Math.floor((TW - width) / 2)));

console.log();
rows.forEach((r) => console.log(lead + r.out));
console.log();
console.log(muted(TAG));
console.log();
