// PRAANA logo — ANSI-shadow block "PN" monogram + trailing fade dots + tagline.
// Cream P (nord6) + sage-green N (nord14). Block letters with a diagonal
// dot fade trailing off the N (echoing the line-art memory-decay motif).
import chalk from "chalk";

const CREAM = "#ECEFF4"; // nord6
const GREEN = "#A3BE8C"; // nord14 sage
const MUTED = "#D8DEE9"; // nord4

const cream = (s) => chalk.hex(CREAM)(s);
const green = (s) => chalk.hex(GREEN)(s);
const muted = (s) => chalk.hex(MUTED)(s);

const TAG = "Adaptive Context · Cognitive Memory";
const TW = TAG.length; // 35

// ANSI-shadow block glyphs (6 rows)
const P = [
  "██████╗ ",
  "██╔══██╗",
  "██████╔╝",
  "██╔═══╝ ",
  "██║     ",
  "╚═╝     ",
];
const N = [
  "███╗   ██╗",
  "████╗  ██║",
  "██╔██╗ ██║",
  "██║╚██╗██║",
  "██║ ╚████║",
  "╚═╝  ╚═══╝",
];
const GAP = " ";

// trailing fade dots, appended diagonally off the N's lower-right
const TRAIL = ["", "", "", " ●", "  ◦", "   ·"];

const rows = P.map((p, i) => {
  const n = N[i] ?? "";
  const t = TRAIL[i] ?? "";
  return {
    raw: p + GAP + n + t,
    out: cream(p) + GAP + green(n) + green(t),
  };
});
const width = Math.max(...rows.map((r) => [...r.raw].length));
const lead = " ".repeat(Math.max(0, Math.floor((TW - width) / 2)));

console.log();
rows.forEach((r) => console.log(lead + r.out));
console.log();
console.log(muted(TAG));
console.log();
