import { fetchOutcome, httpUrl, readResponse, type Runner, type RunnerDeps } from "./base.js";

export function createJinaRunner(deps: RunnerDeps = {}): Runner {
  return {
    id: "jina", backend: "jina", keyless: true,
    fetch: (url, maxChars) => fetchOutcome(deps, async () => {
      const { text, response } = await readResponse(deps, `https://r.jina.ai/${httpUrl(url)}`, { headers: { Accept: "text/plain" } });
      return { content: text, status: response.status };
    }, maxChars),
  };
}
