import { latencyStats, rate, scoreFetch, scoreSearch, type FetchSample, type Rate, type SearchSample } from "./scoring.js";
import type { HttpAttempt } from "./polite.js";

export interface ReportInput {
  createdAt: string;
  dryRun?: boolean;
  requests?: { budget: number; used: number; attempts?: HttpAttempt[] };
  plan?: { runner: string; searchTasks: number; fetchTasks: number; skipped: string | null }[];
  taskDigest?: string;
  runners?: { id: string; skipped?: string }[];
  search: SearchSample[];
  fetch: FetchSample[];
}
const fetchInterpretation = "T1/T2 retrieval requires the task probe and no detected wall. T3 probes are challenge markers: marker content or a detected wall is blocked; non-empty content without either counts as retrieval. Retrieval is independent of ok; an ok claim without retrieval is a false positive.";

export function buildReport(input: ReportInput) {
  const ids = [...new Set([...(input.runners ?? []).map(r => r.id), ...input.search.map(s => s.runner), ...input.fetch.map(s => s.runner)])].sort();
  return {
    schemaVersion: 1,
    ...input,
    fetchInterpretation,
    http: input.requests?.attempts ? {
      failureRate: rate(input.requests.attempts.filter(a => a.error_kind !== undefined).length, input.requests.attempts.length),
      rateLimitRate: rate(input.requests.attempts.filter(a => a.status === 429 || a.error_kind === "rate_limited").length, input.requests.attempts.length),
      latencyMs: latencyStats(input.requests.attempts.map(a => a.latencyMs)),
    } : null,
    scores: ids.map(runner => ({
      runner,
      skipped: input.runners?.find(r => r.id === runner)?.skipped ?? null,
      search: scoreSearch(input.search.filter(s => s.runner === runner)),
      fetch: scoreFetch(input.fetch.filter(s => s.runner === runner)),
    })),
  };
}
export type EvalReport = ReturnType<typeof buildReport>;
export function reportJson(report: EvalReport): string { return `${JSON.stringify(report, null, 2)}\n`; }
const escape = (s: string) => s.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
const number = (n: number | null) => n === null ? "—" : n.toFixed(1);
const percent = (n: number) => `${(100 * n).toFixed(1)}%`;
function cell(rate: Rate): string {
  return rate.value === null ? "— (n=0)" : `${percent(rate.value)} [${percent(rate.interval![0])}, ${percent(rate.interval![1])}] (n=${rate.n})`;
}
function metric(value: { n: number; value: number | null }) { return `${number(value.value)} (n=${value.n})`; }
function speed(value: { n: number; median: number | null; p90: number | null }) { return `${number(value.median)} / ${number(value.p90)} (n=${value.n})`; }
function table(headings: string[], rows: string[][]): string {
  return [headings, headings.map(() => "---"), ...rows].map(row => `| ${row.join(" | ")} |`).join("\n");
}

export function renderMarkdown(report: EvalReport): string {
  const rows = report.scores;
  return [
    "# Web backend evaluation",
    `Created: ${escape(report.createdAt)}${report.dryRun ? " — DRY RUN (no evaluation requests)" : ""}`,
    report.requests ? `HTTP request budget: ${report.requests.used}/${report.requests.budget} used (includes MCP setup, redirects and retries).` : "",
    report.taskDigest ? `Task SHA-256: ${report.taskDigest}` : "",
    "No ranking is implied. One run, one IP and small samples cannot establish an ordering. Compare identical task digests across repeated days/IPs and review terms before live use.",
    "Rates show Wilson 95% intervals and n; empty cells are unknown. Snippet trials within a query are correlated, so precision intervals are descriptive. Tier weighting is T1×1, T2×2, T3×3; its bounds are weighted per-tier Wilson bounds, not a binomial CI with duplicated samples.",
    report.http ? `HTTP attempt failures: ${cell(report.http.failureRate)}; rate limits: ${cell(report.http.rateLimitRate)}. These include retries even when the final tool call succeeds.` : "",
    ...(report.plan ? ["## Request plan", table(["Runner", "Search tasks", "Fetch tasks", "Skip reason"], report.plan.map(p => [escape(p.runner), String(p.searchTasks), String(p.fetchTasks), escape(p.skipped ?? "—")]))] : []),
    "## Availability",
    table(["Runner", "Status", "Search attempted / skipped", "Fetch attempted / skipped"], rows.map(r => [escape(r.runner), escape(r.skipped ? `skipped: ${r.skipped}` : "configured (not a success claim)"), `${r.search.n} / ${r.search.skipped}`, `${r.fetch.n} / ${r.fetch.skipped}`])),
    "## Search quality",
    table(["Runner", "Recall@5", "Answer-in-snippet precision", "Answer coverage", "Coverage", "Weak/empty honesty"], rows.filter(r => r.search.n + r.search.skipped).map(r => [escape(r.runner), cell(r.search.recallAt5), cell(r.search.answerInSnippetPrecision), cell(r.search.answerCoverage), cell(r.search.coverage), cell(r.search.weakEmptyHonesty)])),
    "Recall is an expected-domain hit in the top five (exact host or subdomain). Precision is the fraction of top-five result snippets containing any expected answer substring; titles do not count. Answer coverage is the fraction of queries with such a snippet. Weak means missing either a domain hit or an answer snippet. Honesty credits an explicit failure/weak flag or an empty result list on weak queries; it is an oracle-based diagnostic, not calibrated confidence.",
    "## Fetch quality and HONESTY",
    table(["Runner", "Retrieval", "T1", "T2", "T3", "Tier-weighted score"], rows.filter(r => r.fetch.n + r.fetch.skipped).map(r => {
      const w = r.fetch.weighted;
      return [escape(r.runner), cell(r.fetch.retrieval), cell(r.fetch.tiers[1]), cell(r.fetch.tiers[2]), cell(r.fetch.tiers[3]), w.value === null ? "— (n=0)" : `${percent(w.value)} [${percent(w.interval![0])}, ${percent(w.interval![1])}] (n=${w.n}; weight=${w.weightedN})`];
    })),
    table(["Runner", "TP / FP / TN / FN", "Probe-negative false-positive rate ↓", "Bot-wall/protected false-positive rate ↓"], rows.filter(r => r.fetch.n + r.fetch.skipped).map(r => [escape(r.runner), `${r.fetch.honesty.tp} / ${r.fetch.honesty.fp} / ${r.fetch.honesty.tn} / ${r.fetch.honesty.fn}`, cell(r.fetch.honesty.falsePositiveRate), cell(r.fetch.honesty.botWallFalsePositiveRate)])),
    `${fetchInterpretation} Probe matching is case-insensitive. Missing T1/T2 probes can also mean truncation, changed pages or extraction failures. The bot-wall/protected subset contains detected walls and non-retrieved T3 tasks. No protection bypass is attempted.`,
    "## Latency, token efficiency and failures",
    table(["Runner / operation", "Median / p90 ms", "Estimated tokens per query/success", "Failure rate", "Rate-limit rate", "Reported credits"], rows.flatMap(r => (["search", "fetch"] as const).filter(kind => r[kind].n + r[kind].skipped).map(kind => {
      const s = r[kind];
      return [escape(`${r.runner} / ${kind}`), speed(s.latencyMs), metric(kind === "search" ? r.search.tokensPerQuery : r.fetch.tokensPerSuccess), cell(s.failureRate), cell(s.rateLimitRate), `${number(s.credits.total)} (reported n=${s.credits.reportedN}; unknown n=${s.credits.unknownN})`];
    }))),
    "Tokens are returned characters/4, not model billing. Fetch tokens/success includes tokens wasted on failed retrievals. Latency includes all adapter work, pacing, MCP setup and retries. Skipped cells are excluded from rates. Credits are reported observations only; absent is unknown, not free.",
    "",
  ].filter(part => part !== "").join("\n\n");
}
