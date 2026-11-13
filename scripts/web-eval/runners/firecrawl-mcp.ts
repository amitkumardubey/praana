import { fetchOutcome, httpUrl, searchOutcome, type Runner, type RunnerDeps } from "./base.js";
import { firecrawlScrape, firecrawlSearch } from "./firecrawl.js";
import { createMcpClient, mcpJson } from "./mcp.js";

export function createFirecrawlMcpRunner(deps: RunnerDeps = {}): Runner {
  const client = createMcpClient("https://mcp.firecrawl.dev/v2/mcp", deps);
  return {
    id: "firecrawl-mcp", backend: "firecrawl", keyless: true,
    search: (query, maxResults) => searchOutcome(deps, async () => {
      const result = await client.call("firecrawl_search", { query, limit: maxResults, sources: ["web"] });
      return firecrawlSearch(mcpJson(result));
    }, maxResults),
    fetch: (url, maxChars) => fetchOutcome(deps, async () => {
      const result = await client.call("firecrawl_scrape", { url: httpUrl(url), formats: ["markdown"], onlyMainContent: true });
      // The official MCP scrape tool unwraps the API's data envelope.
      return firecrawlScrape({ success: true, data: mcpJson(result) });
    }, maxChars),
  };
}
