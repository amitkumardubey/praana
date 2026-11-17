import type { Runner, RunnerDeps } from "./base.js";
import { createLocalFetchRunner } from "./local-fetch.js";
import { createJinaRunner } from "./jina.js";
import { createExaMcpRunner } from "./exa-mcp.js";
import { createParallelMcpRunner } from "./parallel-mcp.js";
import { createTavilyRunner, createTavilyKeylessRunner } from "./tavily.js";
import { createBraveRunner } from "./brave.js";
import { createExaRunner } from "./exa.js";
import { createFirecrawlRunner } from "./firecrawl.js";
import { createFirecrawlMcpRunner } from "./firecrawl-mcp.js";

export type RunnerFactory = (deps: RunnerDeps) => Runner;
/** Stable enumeration, not a ranking. Constructors perform no I/O. */
export const runnerFactories: RunnerFactory[] = [
  createLocalFetchRunner, createJinaRunner, createExaMcpRunner,
  createParallelMcpRunner, createTavilyKeylessRunner, createFirecrawlMcpRunner,
  createTavilyRunner, createBraveRunner, createExaRunner, createFirecrawlRunner,
];
export const KEY_ENV_NAMES = ["TAVILY_API_KEY", "BRAVE_API_KEY", "EXA_API_KEY", "FIRECRAWL_API_KEY"] as const;
