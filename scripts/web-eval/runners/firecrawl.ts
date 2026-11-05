import { classifyError, fetchOutcome, httpUrl, parseResults, RunnerError, searchOutcome, skippedFetch, skippedSearch, string, type Runner, type RunnerDeps } from "./base.js";
import { credits, envKey, jsonRequest } from "./api.js";

export function firecrawlSearch(data: any) {
  if (data?.success === false) throw new RunnerError(classifyError(undefined, string(data.error)));
  return { results: parseResults(data?.data?.web, r => ({ url: string(r.url), title: string(r.title), snippet: string(r.description) })), credits: credits(data.creditsUsed) };
}
export function firecrawlScrape(data: any) {
  if (!data || data.success === false || typeof data.data?.markdown !== "string") throw new RunnerError(classifyError(undefined, string(data?.error)));
  const status = typeof data.data.metadata?.statusCode === "number" ? data.data.metadata.statusCode : undefined;
  if (status !== undefined && status >= 400) throw new RunnerError(classifyError(status, data.data.markdown), status);
  return { content: data.data.markdown as string, status, credits: credits(data.creditsUsed) };
}

export function createFirecrawlRunner(deps: RunnerDeps = {}): Runner {
  const key = envKey(deps, "FIRECRAWL_API_KEY");
  const skipped = key ? undefined : "no key";
  const checkKey = () => { if (!key?.startsWith("fc-")) throw new RunnerError("invalid_key"); };
  return {
    id: "firecrawl", backend: "firecrawl", keyless: false, skipped,
    search: (query, maxResults) => skipped ? Promise.resolve(skippedSearch(skipped)) : searchOutcome(deps, async () => {
      checkKey();
      // Deliberately omit scrapeOptions: fetching each result would incur separate scrape credits.
      const { data, status } = await jsonRequest(deps, "https://api.firecrawl.dev/v2/search", { Authorization: `Bearer ${key}` }, { query, limit: Math.min(100, maxResults), sources: ["web"] });
      return { ...firecrawlSearch(data), status };
    }, maxResults),
    fetch: (url, maxChars) => skipped ? Promise.resolve(skippedFetch(skipped)) : fetchOutcome(deps, async () => {
      checkKey();
      const { data } = await jsonRequest(deps, "https://api.firecrawl.dev/v2/scrape", { Authorization: `Bearer ${key}` }, { url: httpUrl(url), formats: ["markdown"], onlyMainContent: true });
      return firecrawlScrape(data);
    }, maxChars),
  };
}
