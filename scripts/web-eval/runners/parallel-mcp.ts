import { skippedSearch, type Runner, type RunnerDeps } from "./base.js";

/**
 * Official quickstart verifies https://mcp.parallel.ai/mcp and web_search with
 * objective/search_queries. It does not specify the MCP result encoding; the
 * REST Search API sample alone does not verify the hosted MCP output format.
 * Do not guess that REST JSON is preserved by the MCP wrapper. See README.
 */
export function createParallelMcpRunner(_deps: RunnerDeps = {}): Runner {
  return {
    id: "parallel-mcp", backend: "parallel", keyless: true,
    skipped: "endpoint not verified",
    search: async () => skippedSearch("endpoint not verified"),
  };
}
