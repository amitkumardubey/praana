import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { capture, parseSize } from "./capture";
import { analyzeSamples, readSamples, type Report } from "./analyze";
import { startMock } from "./mock-llm";

const metrics = ["regressions", "scrollReversals", "aba", "styleFlips"] as const;
type Metric = typeof metrics[number];
type Stat = { mean: number; min: number; max: number; rate: number };
export type Summary = Record<Metric, Stat> & { hz: number; unmatchedRatio: number };
export type Thresholds = Partial<Record<Metric, number>>;
export function summarize(reports: Report[]): Summary {
  if (!reports.length) throw new Error("No reports to summarize");
  const result = {} as Summary;
  for (const metric of metrics) {
    const values = reports.map(r => r[metric]);
    result[metric] = { mean: values.reduce((a, b) => a + b, 0) / values.length, min: Math.min(...values), max: Math.max(...values), rate: reports.reduce((a, r) => a + r[metric] * 1000 / r.sampleCount, 0) / reports.length };
  }
  result.hz = reports.reduce((a, r) => a + r.achievedHz, 0) / reports.length;
  result.unmatchedRatio = reports.reduce((a, r) => a + r.unmatchedRatio, 0) / reports.length;
  return result;
}
export function checkThresholds(reports: Report[], limits: Thresholds): string[] {
  const s = summarize(reports);
  return metrics.filter(m => m === "styleFlips" ? limits[m] !== undefined && s[m].rate > limits[m]! : s[m].max > (limits[m] ?? 0));
}
export function formatTable(a: string, x: Summary, b: string, y: Summary): string {
  const fmt = (s: Stat) => `${s.mean.toFixed(2)} / ${s.min} / ${s.max} / ${s.rate.toFixed(2)}`;
  return [`metric                 ${a}: mean / min / max / rate/1k     ${b}: mean / min / max / rate/1k`, ...metrics.map(m => `${m.padEnd(22)} ${fmt(x[m]).padEnd(36)} ${fmt(y[m])}`), `mean Hz                ${x.hz.toFixed(2).padEnd(36)} ${y.hz.toFixed(2)}`, `mean unmatchedRatio    ${x.unmatchedRatio.toFixed(4).padEnd(36)} ${y.unmatchedRatio.toFixed(4)}`].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const value = (key: string, fallback?: string) => { const i = args.indexOf(key); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(`Missing value for ${key}`); return args[i + 1]; };
  const noise = value("--noise");
  const a = noise ?? value("--a"), b = value("--b");
  if (!a || (!noise && !b)) throw new Error("Provide --a and --b, or --noise");
  const labelA = value("--label-a", "A")!, labelB = value("--label-b", "B")!;
  const runs = Number(value("--runs", "5")), delay = Number(value("--delay-ms", "12"));
  if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(delay) || delay < 0) throw new Error("Invalid runs or delay");
  const sizes: string[] = []; for (let i = 0; i < args.length; i++) if (args[i] === "--size") { if (!args[i + 1]) throw new Error("Missing size"); sizes.push(args[i + 1]!); }
  if (!sizes.length) sizes.push("110x40"); sizes.forEach(parseSize);
  const out = resolve(value("--out", join(homedir(), ".cache/probe-scratch/ab", new Date().toISOString().replaceAll(":", "-")))!); mkdirSync(out, { recursive: true });
  const thresholds: Thresholds = {};
  for (const m of metrics) { const v = value(`--${m}`); if (v !== undefined) { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid threshold ${m}`); thresholds[m] = n; } }
  const server = startMock(9779, delay);
  await new Promise<void>((ok, fail) => { server.once("listening", ok); server.once("error", fail); });
  let failed = false;
  try {
    for (const size of sizes) {
      const startLoad = loadavg(); const reportsA: Report[] = [], reportsB: Report[] = [];
      console.log(`Batch ${size} start load ${startLoad.join(" ")}`);
      for (let i = 1; i <= runs; i++) for (const [path, label, reports] of [[a, labelA, reportsA], ...(noise ? [] : [[b!, labelB, reportsB]])] as [string, string, Report[]][]) {
        for (let attempt = 0; attempt <= 2; attempt++) {
          const file = join(out, `${size}-${label}-${i}-attempt${attempt + 1}.jsonl`);
          const result = await capture(path, label, size, 120, file);
          const report = analyzeSamples(await readSamples(file), { height: parseSize(size).height });
          writeFileSync(file + ".report.json", JSON.stringify(report, null, 2));
          console.log(`${size} ${label} run ${i} attempt ${attempt + 1}: ${result.hz.toFixed(2)} Hz ${result.hz < 60 ? "INVALID" : "valid"} ${file}`);
          if (result.hz >= 60) { reports.push(report); break; }
          if (attempt === 2) throw new Error(`Capture below 60 Hz after two redos: ${file}`);
        }
      }
      const endLoad = loadavg();
      const summaryA = summarize(reportsA), summaryB = summarize(noise ? reportsA : reportsB);
      const table = formatTable(labelA, summaryA, noise ? `${labelA} noise` : labelB, summaryB);
      console.log(table); console.log(`Batch ${size} end load ${endLoad.join(" ")}`);
      writeFileSync(join(out, `${size}-summary.json`), JSON.stringify({ startLoad, endLoad, labelA, labelB: noise ? labelA : labelB, summaryA, summaryB, filesA: reportsA.map(r => ({ hz: r.achievedHz, sampleCount: r.sampleCount })), filesB: reportsB.map(r => ({ hz: r.achievedHz, sampleCount: r.sampleCount })), table }, null, 2));
      if (args.includes("--check")) { const violations = checkThresholds(noise ? reportsA : reportsB, thresholds); if (violations.length) { console.error(`Thresholds exceeded: ${violations.join(", ")}`); failed = true; } }
    }
  } finally { server.close(); }
  if (failed) process.exitCode = 1;
}
if (import.meta.main) await main();
