import { parseResults, searchOutcome, skippedSearch, string, type Runner, type RunnerDeps } from "./base.js";
import { envKey, jsonRequest } from "./api.js";

export function exaResults(rows: unknown) {
  return parseResults(rows, r => ({ url: string(r.url), title: string(r.title), snippet: Array.isArray(r.highlights) ? r.highlights.map(string).join("\n") : string(r.text) }));
}
export function createExaRunner(deps: RunnerDeps = {}): Runner {
  const key = envKey(deps, "EXA_API_KEY");
  const skipped = key ? undefined : "no key";
  return {
    id: "exa", backend: "exa", keyless: false, skipped,
    search: (query, maxResults) => skipped ? Promise.resolve(skippedSearch(skipped)) : searchOutcome(deps, async () => {
      const { data, status } = await jsonRequest(deps, "https://api.exa.ai/search", { "x-api-key": key! }, { query, numResults: Math.min(100, maxResults), type: "auto", contents: { highlights: true } });
      return { results: exaResults(data.results), status };
    }, maxResults),
  };
}
