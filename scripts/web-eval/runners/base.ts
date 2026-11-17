export type ErrorKind = "invalid_key" | "credit_depleted" | "rate_limited" | "server_error" | "timeout" | "blocked" | "other";
export type HttpRequest = (url: string, init?: RequestInit) => Promise<Response>;
export interface RunnerDeps {
  request?: HttpRequest;
  now?: () => number;
  env?: Record<string, string | undefined>;
}
export interface Outcome {
  ok: boolean;
  latencyMs: number;
  /** Estimated returned-text tokens, not provider/model usage. */
  tokens: number;
  status?: number;
  error_kind?: ErrorKind;
  blocked?: boolean;
  skipped?: string;
  /** Optional explicit acknowledgement of weak search evidence. */
  weak?: boolean;
  /** Provider-reported credits only. Absent means unknown, not zero. */
  credits?: number;
}
export interface SearchResult { url: string; title: string; snippet: string }
export interface SearchOutcome extends Outcome { results: SearchResult[] }
export interface FetchOutcome extends Outcome { content: string }
export interface Runner {
  id: string;
  /** Adapters sharing a backend share one pacing queue. */
  backend: string;
  keyless: boolean;
  skipped?: string;
  search?: (query: string, maxResults: number) => Promise<SearchOutcome>;
  fetch?: (url: string, maxChars: number) => Promise<FetchOutcome>;
}

export const USER_AGENT = "praana-web-eval/0.1";
export const estimateTokens = (text: string): number => text.length / 4;
export const defaultRequest: HttpRequest = (url, init) => globalThis.fetch(url, {
  ...init, redirect: "manual", signal: init?.signal ?? AbortSignal.timeout(30_000),
});

export function classifyError(status?: number, hint = ""): ErrorKind {
  if (status === 401 || /invalid.{0,20}(api.?key|token)|api.?key.{0,20}(invalid|required|missing)/i.test(hint)) return "invalid_key";
  if (status === 402 || /credits?.{0,20}(exhausted|depleted|insufficient)|insufficient.{0,20}(credits?|balance)/i.test(hint)) return "credit_depleted";
  if (status === 429 || /rate.?limit/i.test(hint)) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";
  if ((status !== undefined && status >= 500) || /internal (server )?error|server error|service unavailable/i.test(hint)) return "server_error";
  if (status === 403 || isBotWall(hint)) return "blocked";
  return "other";
}

/** Conservative hints, not a proof of real content. The task probe is the scoring oracle. */
export function isBotWall(text: string): boolean {
  return /<title>\s*(just a moment|attention required)|verify (that )?you are human|checking your browser before|cf-chl-|captcha challenge|enable javascript and cookies to continue|access denied.{0,100}(cloudflare|bot)/is.test(text);
}

export class SkippedError extends Error {
  constructor(public reason: string) { super(reason); }
}

export class RunnerError extends Error {
  constructor(public kind: ErrorKind, public status?: number) { super(kind); }
}

export function httpUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new RunnerError("other");
  return url.href;
}

export async function readResponse(deps: RunnerDeps, url: string, init?: RequestInit): Promise<{ text: string; response: Response }> {
  const headers = new Headers(init?.headers);
  headers.set("User-Agent", USER_AGENT);
  const response = await (deps.request ?? defaultRequest)(url, { ...init, headers });
  const text = await response.text();
  if (!response.ok) throw new RunnerError(classifyError(response.status, text), response.status);
  return { text, response };
}

export function failure(error: unknown, latencyMs: number): Outcome {
  // Never propagate raw exceptions, request headers, URLs or provider error bodies.
  if (error instanceof SkippedError) return { ok: false, latencyMs, tokens: 0, skipped: error.reason };
  if (error instanceof RunnerError) return { ok: false, latencyMs, tokens: 0, status: error.status, error_kind: error.kind, blocked: error.kind === "blocked" };
  const name = error instanceof Error ? error.name : "";
  return { ok: false, latencyMs, tokens: 0, error_kind: /Timeout|Abort/.test(name) ? "timeout" : "other" };
}

export async function fetchOutcome(deps: RunnerDeps, operation: () => Promise<{ content: string; status?: number; credits?: number; blocked?: boolean }>, maxChars: number): Promise<FetchOutcome> {
  const now = deps.now ?? performance.now.bind(performance);
  const start = now();
  try {
    if (!Number.isInteger(maxChars) || maxChars < 1) throw new RunnerError("other");
    const value = await operation();
    const blocked = value.blocked ?? isBotWall(value.content);
    const content = value.content.slice(0, maxChars);
    const ok = !!content.trim() && !blocked;
    return { ...value, content, ok, blocked, error_kind: blocked ? "blocked" : ok ? undefined : "other", latencyMs: now() - start, tokens: estimateTokens(content) };
  } catch (error) { return { ...failure(error, now() - start), content: "" }; }
}

export async function searchOutcome(deps: RunnerDeps, operation: () => Promise<{ results: SearchResult[]; status?: number; credits?: number }>, maxResults: number): Promise<SearchOutcome> {
  const now = deps.now ?? performance.now.bind(performance);
  const start = now();
  try {
    if (!Number.isInteger(maxResults) || maxResults < 1) throw new RunnerError("other");
    const value = await operation();
    const results = value.results.slice(0, maxResults);
    return { ...value, results, ok: true, latencyMs: now() - start, tokens: estimateTokens(results.map(r => `${r.title}\n${r.url}\n${r.snippet}`).join("\n")) };
  } catch (error) { return { ...failure(error, now() - start), results: [] }; }
}

export function skippedSearch(reason: string): SearchOutcome {
  return { ok: false, results: [], tokens: 0, latencyMs: 0, skipped: reason };
}
export function skippedFetch(reason: string): FetchOutcome {
  return { ok: false, content: "", tokens: 0, latencyMs: 0, skipped: reason };
}

export function parseResults(rows: unknown, parse: (row: Record<string, unknown>) => SearchResult): SearchResult[] {
  if (!Array.isArray(rows)) throw new RunnerError("other");
  return rows.map(row => {
    if (!row || typeof row !== "object") throw new RunnerError("other");
    const result = parse(row);
    httpUrl(result.url);
    return result;
  });
}
export function string(value: unknown): string { return typeof value === "string" ? value : ""; }
