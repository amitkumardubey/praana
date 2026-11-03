import stripAnsi from "strip-ansi";
import { fixture } from "./mock-llm";
import type { Sample } from "./capture";

// Fixture line numbers are one-based source lines, including blank and fence lines.
// Normalize presentation markers, links and padded table cells, but preserve words.
function normalize(s: string): string {
  return s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s()]*)\s+\(https?:\/\/[^\s()]*(?:\)|$)/g, "$1 $2")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/[`*_~#>|│┃•–─┌┐└┘├┤┬┴┼█▄▀\[\]()]/g, " ")
    .replace(/(^|\s)-(?=\s)/g, "$1 ").replace(/\s+/g, " ").trim();
}
const expected = fixture.split("\n").map(normalize);
const chrome = /(?:\b(?:replying|thinking|working)…|message praana|^\s*(?:praana ·|ctx \d|✓ ctx |please provide the markdown fixture\.|type a message to start|\d+ skills discovered|v\d+\.\d+))/i;

/** A prompt alone indicates completion only when no active status remains. */
export function finished(screen: string): boolean {
  const text = stripAnsi(screen);
  return /message praana/i.test(text) && !/(?:replying|thinking|working)…/i.test(text);
}

// Track SGR state per character: bold, dim, and foreground/background colours.
// Marker and first non-marker cell are sampled independently, ignoring other SGRs.
type Sgr = { bold: boolean; dim: boolean; fg: string; bg: string };
function styles(raw: string, state: Sgr): string {
  let { bold, dim, fg, bg } = state;
  const chars: { char: string; style: string }[] = [];
  const tokens = raw.match(/\x1b\[[0-9;:]*m|[^\x1b]/gu) ?? [];
  for (const token of tokens) {
    if (token.startsWith("\x1b[")) {
      const codes = token.slice(2, -1).replaceAll(":", ";").split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const n = codes[i]!;
        if (n === 0) { bold = false; dim = false; fg = ""; bg = ""; }
        else if (n === 1) bold = true;
        else if (n === 2) dim = true;
        else if (n === 22) { bold = false; dim = false; }
        else if (n === 39) fg = "";
        else if (n === 49) bg = "";
        else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) fg = String(n);
        else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) bg = String(n);
        else if (n === 38 || n === 48) {
          const count = codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : 0;
          const color = codes.slice(i, i + count + 1).join(";");
          if (n === 38) fg = color; else bg = color;
          i += count;
        }
      }
    } else chars.push({ char: token, style: `${+bold},${+dim},${fg},${bg}` });
  }
  Object.assign(state, { bold, dim, fg, bg });
  let i = chars.findIndex((c) => !/\s/.test(c.char));
  if (i < 0) return "";
  let marker = "";
  while (i < chars.length && /[-–•│┃>|#`~*\s]/.test(chars[i]!.char)) {
    if (!marker && !/\s/.test(chars[i]!.char)) marker = chars[i]!.style;
    i++;
  }
  return `${marker}|${chars[i]?.style ?? ""}`;
}

export interface Report {
  sampleCount: number; durationMs: number; achievedHz: number; distinctScreens: number;
  unmatchedRatio: number; regressions: number; scrollReversals: number; aba: number; styleFlips: number;
  samples: { firstVisible: number | null; lastVisible: number | null }[];
  offenders: { index: number; metrics: string[]; excerpt: string[] }[];
}

/** Analyze captured terminal states; indices in offenders are zero-based. */
export function analyzeSamples(samples: Sample[], opts: { height: number }): Report {
  const report: Report = { sampleCount: samples.length, durationMs: 0, achievedHz: 0, distinctScreens: 0, unmatchedRatio: 0, regressions: 0, scrollReversals: 0, aba: 0, styleFlips: 0, samples: [], offenders: [] };
  const screens: string[] = [];
  const seenScreens = new Set<string>();
  const lineStyles: Map<string, string>[] = [];
  const excerpts: string[][] = [];
  const offenses = new Map<number, Set<string>>();
  const flag = (index: number, metric: string) => {
    if (!offenses.has(index)) offenses.set(index, new Set());
    offenses.get(index)!.add(metric);
  };
  let unmatched = 0, total = 0, furthest = 0;
  let previous: { firstVisible: number | null; lastVisible: number | null } | undefined;
  for (let k = 0; k < samples.length; k++) {
    const rows = samples[k]!.text.split("\n");
    if (rows.at(-1) === "") rows.pop();
    // Synthetic partial screens may have fewer rows; position exclusion applies only to full screens.
    const content = rows.length >= opts.height ? rows.slice(0, opts.height - (opts.height <= 24 ? 5 : 6)) : rows;
    const cleaned = content.map((x) => stripAnsi(x).trimEnd()).filter((x) => !chrome.test(x));
    const screen = cleaned.join("\n");
    screens.push(screen); seenScreens.add(screen);
    excerpts.push(cleaned.filter((s) => s.trim()).slice(-3));
    const currentStyles = new Map<string, string>();
    const found: number[] = [];
    const sgr: Sgr = { bold: false, dim: false, fg: "", bg: "" };
    for (const raw of content) {
      const style = styles(raw, sgr);
      const text = stripAnsi(raw).trimEnd();
      if (chrome.test(text)) continue;
      const normalized = normalize(text);
      if (!normalized || /^[-: ]+$/.test(normalized)) continue;
      total++;
      // A visible fragment can be a growing prefix or a wrapped substring of a fixture line.
      const idx = expected.findIndex((e) => e && (e === normalized || (normalized.length >= 12 && (e.includes(normalized) || normalized.startsWith(e)))));
      if (idx < 0) { unmatched++; continue; }
      found.push(idx + 1);
      currentStyles.set(`${idx + 1}:${text.trim()}`, style);
    }
    lineStyles.push(currentStyles);
    const entry = { firstVisible: found.length ? found[0]! : null, lastVisible: found.length ? found[found.length - 1]! : null };
    report.samples.push(entry);
    // Regression compares with the furthest end in any earlier matched sample.
    if (entry.lastVisible !== null) {
      if (entry.lastVisible < furthest) { report.regressions++; flag(k, "regressions"); }
      furthest = Math.max(furthest, entry.lastVisible);
      // A reversal compares consecutive matched samples, ignoring intervening unmatched frames.
      if (previous?.firstVisible != null && previous.lastVisible != null && entry.firstVisible! < previous.firstVisible && entry.lastVisible >= previous.lastVisible) {
        report.scrollReversals++; flag(k, "scrollReversals");
      }
      previous = entry;
    }
    // Text ABA is an exact return of the transcript viewport (not status/footer chrome).
    if (k >= 2 && screens[k] === screens[k - 2] && screens[k] !== screens[k - 1]) { report.aba++; flag(k - 1, "aba"); }
    // Count one flip per line at the changed frame when its former style returns within 3 samples.
    if (k >= 2) {
      for (const [key, style] of currentStyles) {
        for (let changed = Math.max(1, k - 3); changed < k; changed++) {
          const before = lineStyles[changed - 1]!.get(key), middle = lineStyles[changed]!.get(key);
          if (before === style && middle !== undefined && middle !== style && !lineStyles.slice(changed + 1, k).some((m) => m.get(key) === style)) {
            report.styleFlips++; flag(changed, "styleFlips"); break;
          }
        }
      }
    }
  }
  report.durationMs = samples.length > 1 ? Math.max(0, samples.at(-1)!.timestamp - samples[0]!.timestamp) : 0;
  // Hz is intervals per elapsed second, rather than frames divided by elapsed time.
  report.achievedHz = report.durationMs ? (samples.length - 1) * 1000 / report.durationMs : 0;
  report.distinctScreens = seenScreens.size;
  report.unmatchedRatio = total ? unmatched / total : 0;
  report.offenders = [...offenses].sort((a, b) => a[0] - b[0]).slice(0, 10).map(([index, metrics]) => ({ index, metrics: [...metrics], excerpt: excerpts[index]! }));
  return report;
}

/** Optional I/O boundary for capture JSONL; analysis itself is pure. */
export async function readSamples(path: string): Promise<Sample[]> {
  return (await Bun.file(path).text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Sample);
}
