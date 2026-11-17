import { parseResults, searchOutcome, skippedSearch, string, type Runner, type RunnerDeps } from "./base.js";
import { credits, envKey, jsonRequest } from "./api.js";

function tavily(deps: RunnerDeps, keyless: boolean): Runner {
  const key = keyless ? undefined : envKey(deps, "TAVILY_API_KEY");
  const skipped = !keyless && !key ? "no key" : undefined;
  return {
    id: keyless ? "tavily-keyless" : "tavily", backend: "tavily", keyless, skipped,
    search: (query, maxResults) => skipped ? Promise.resolve(skippedSearch(skipped)) : searchOutcome(deps, async () => {
      const { data, status } = await jsonRequest(deps, "https://api.tavily.com/search", keyless ? { "X-Tavily-Access-Mode": "keyless" } : { Authorization: `Bearer ${key}` }, {
        query, max_results: Math.min(20, maxResults), search_depth: "basic", include_answer: false, include_raw_content: false, include_usage: true,
      });
      return { results: parseResults(data.results, r => ({ url: string(r.url), title: string(r.title), snippet: string(r.content) })), status, credits: credits(data.usage?.credits) };
    }, maxResults),
  };
}
export function createTavilyRunner(deps: RunnerDeps = {}): Runner { return tavily(deps, false); }
/** Explicit opt-in runner; never silently fall back from a keyed call to anonymous usage. */
export function createTavilyKeylessRunner(deps: RunnerDeps = {}): Runner { return tavily(deps, true); }
