import { parseResults, RunnerError, searchOutcome, type Runner, type RunnerDeps } from "./base.js";
import { exaResults } from "./exa.js";
import { createMcpClient, mcpText } from "./mcp.js";

export function createExaMcpRunner(deps: RunnerDeps = {}): Runner {
  const client = createMcpClient("https://mcp.exa.ai/mcp", deps);
  return {
    id: "exa-mcp", backend: "exa", keyless: true,
    search: (query, maxResults) => searchOutcome(deps, async () => {
      const result = await client.call("web_search_exa", { query, numResults: maxResults });
      if (result.structuredContent?.results) return { results: exaResults(result.structuredContent.results) };
      const text = mcpText(result);
      if (text.trim() === "No search results found. Please try a different query.") return { results: [] };
      // Official exa-mcp-server webSearch tool's labelled text output.
      const rows = text.split(/\n\n---\n\n/).map(block => {
        const title = /^Title: (.*)$/m.exec(block)?.[1];
        const url = /^URL: (.*)$/m.exec(block)?.[1];
        const snippet = /(?:^Highlights:\n|^Text: )([\s\S]*)/m.exec(block)?.[1] ?? "";
        if (title === undefined || url === undefined) throw new RunnerError("other");
        return { title, url, snippet };
      });
      return { results: parseResults(rows, row => row as unknown as typeof rows[number]) };
    }, maxResults),
  };
}
