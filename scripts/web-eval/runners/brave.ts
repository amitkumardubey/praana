import { parseResults, searchOutcome, skippedSearch, string, type Runner, type RunnerDeps } from "./base.js";
import { envKey, jsonRequest } from "./api.js";

export function createBraveRunner(deps: RunnerDeps = {}): Runner {
  const key = envKey(deps, "BRAVE_API_KEY");
  const skipped = key ? undefined : "no key";
  return {
    id: "brave", backend: "brave", keyless: false, skipped,
    search: (query, maxResults) => skipped ? Promise.resolve(skippedSearch(skipped)) : searchOutcome(deps, async () => {
      const params = new URLSearchParams({ q: query, count: String(Math.min(20, maxResults)), extra_snippets: "true" });
      const { data, status } = await jsonRequest(deps, `https://api.search.brave.com/res/v1/web/search?${params}`, { "X-Subscription-Token": key! });
      // A valid empty search can omit the web section, but must still identify as search.
      const rows = data.web?.results ?? (data.type === "search" ? [] : undefined);
      return { results: parseResults(rows, r => ({ url: string(r.url), title: string(r.title), snippet: [string(r.description), ...(Array.isArray(r.extra_snippets) ? r.extra_snippets.map(string) : [])].filter(Boolean).join("\n") })), status };
    }, maxResults),
  };
}
