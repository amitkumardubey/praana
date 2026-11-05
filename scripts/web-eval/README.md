# Web evaluation (implementation in progress)

Runner implementation is in progress. Do not use these adapters to rank backends;
full task sets, terms review and measured runs are separate work.

Validate a candidate set and check its expected strings against its authoritative
pages with:

```sh
bun scripts/web-eval/verify.ts search scripts/web-eval/tasks/search.json
# Likewise, pass `fetch` and a fetch-task JSON file.
```

The verifier checks page text, reports failures, and exits nonzero if any
expectation is absent or inaccessible. It does not update `verified_at`: review
successful output and update dates explicitly. It waits at least one second
between requests, including redirects, and retries 429/5xx responses at most
twice with exponential delays. It does not evade bot protection. Inaccessible
pages, including tier-3 bot walls, cannot be verified from that vantage point;
a missing probe is not evidence that a page lacks it.

`tasks/schema.json` describes the basic JSON shape; `tasks.ts` is the
more restrictive executable validator (including actual calendar dates and
HTTP(S)-only URLs). Neither currently checks the required full-set counts or
category distribution. The schema is generated from the Zod definitions.

## Adapter verification notes

Official documentation was read with `curl` on 2026-11-05 (documentation only;
no backend evaluation requests):

- Exa hosted MCP: https://docs.exa.ai/reference/exa-mcp — keyless endpoint
  `https://mcp.exa.ai/mcp`, tool `web_search_exa`. Arguments and labelled text
  output verified in the vendor's linked repository:
  https://github.com/exa-labs/exa-mcp-server/blob/master/src/tools/webSearch.ts .
- Parallel: https://docs.parallel.ai/integrations/mcp/quickstart and
  https://docs.parallel.ai/integrations/mcp/programmatic-use verify
  `https://mcp.parallel.ai/mcp` and `web_search(objective, search_queries)`.
  **BLOCKED:** those official pages do not specify the MCP result encoding;
  the REST example does not establish that MCP preserves it. `parallel-mcp`
  reports `skipped: endpoint not verified` (format not verified), without traffic.
  Unblock with an official MCP output example/schema; do not infer REST wrapping.
- Tavily API: https://docs.tavily.com/documentation/api-reference/endpoint/search .
  Explicit keyless header verified at https://docs.tavily.com/documentation/keyless .
  Keyed and keyless are separate runners, never implicit fallback. Whether live
  keyless requests work, and the agreement conflict, remain for the later tasks.
- Brave: https://api-dashboard.search.brave.com/app/documentation/web-search/get-started .
- Exa API: https://docs.exa.ai/reference/search (highlights, not full page text).
- Firecrawl API: https://docs.firecrawl.dev/api-reference/endpoint/search and
  https://docs.firecrawl.dev/api-reference/endpoint/scrape .
- Firecrawl hosted keyless access **is officially documented**, not just a
  third-party claim: https://docs.firecrawl.dev/mcp-server/keyless and
  https://docs.firecrawl.dev/mcp-server/tools . The documented endpoint is
  `https://mcp.firecrawl.dev/v2/mcp`; tool arguments are in the vendor README:
  https://github.com/firecrawl/firecrawl-mcp-server#readme . MCP envelope shapes
  were checked against its `src/server.ts` / `src/tool-output.ts` (interfaces
  only; no vendor code vendored). Search omits `scrapeOptions`; scrape is separate.
  `credits` records reported `creditsUsed` per call. When scrape/keyless output
  does not report it, it stays unknown (absent), never fabricated from pricing.
- MCP Streamable HTTP: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports .

Fixture responses are small, hand-written recordings of documented wire shapes,
not claims of live captures. Tests inject transport and never require keys or
network. WRB's README was read as a style reference; no code was copied.

