import { classifyError, defaultRequest, httpUrl, RunnerError, SkippedError, type ErrorKind, type HttpRequest } from "./runners/base.js";

export interface HttpAttempt { backend: string; status?: number; error_kind?: ErrorKind; latencyMs: number }
interface Queue { tail: Promise<void>; nextAt: number; keylessStopped: boolean }
export interface PoliteOptions {
  maxRequests: number;
  request?: HttpRequest;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Budget at the HTTP boundary, not the task boundary: MCP setup also costs requests. */
export function createPoliteTransport(options: PoliteOptions) {
  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 0) throw new Error("Invalid request budget");
  const request = options.request ?? defaultRequest;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (async ms => { await Bun.sleep(ms); });
  const queues = new Map<string, Queue>();
  const attempts: HttpAttempt[] = [];
  let used = 0, globalNextAt = 0;

  function retryAfter(value: string | null): number {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - now()) : 0;
  }
  return {
    get used() { return used; },
    attempts,
    forBackend(backend: string, keyless: boolean): HttpRequest {
      let queue = queues.get(backend);
      if (!queue) { queue = { tail: Promise.resolve(), nextAt: 0, keylessStopped: false }; queues.set(backend, queue); }
      const state = queue;
      return async (initialUrl, initialInit) => {
        const previous = state.tail;
        let release!: () => void;
        state.tail = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
          if (keyless && state.keylessStopped) throw new SkippedError("backend stopped after keyless 429/5xx");
          let url = httpUrl(initialUrl), init = initialInit, retries = 0, redirects = 0;
          while (true) {
            if (used >= options.maxRequests) throw new SkippedError("request budget exhausted");
            // Global pacing is deliberately stronger than vendor-only pacing.
            while (true) {
              const wait = Math.max(state.nextAt, globalNextAt) - now();
              if (wait <= 0) break;
              await sleep(wait);
            }
            if (used >= options.maxRequests) throw new SkippedError("request budget exhausted");
            used++;
            const started = now();
            state.nextAt = globalNextAt = started + 1000;
            let response: Response;
            try { response = await request(url, { ...init, redirect: "manual", signal: init?.signal ?? AbortSignal.timeout(30_000) }); }
            catch (error) {
              attempts.push({ backend, latencyMs: now() - started, error_kind: error instanceof Error && /Timeout|Abort/.test(error.name) ? "timeout" : "other" });
              throw error; // Never retry ambiguous transport failures or timeouts.
            }
            attempts.push({ backend, status: response.status, latencyMs: now() - started, ...(response.status < 400 ? {} : { error_kind: classifyError(response.status) }) });
            if (response.status === 429 || response.status >= 500) {
              state.nextAt = Math.max(state.nextAt, now() + Math.max(2000 * 2 ** retries, retryAfter(response.headers.get("retry-after"))));
              if (keyless) { state.keylessStopped = true; return response; }
              if (retries++ >= 2) return response;
              await response.body?.cancel();
              continue;
            }
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              const location = response.headers.get("location");
              await response.body?.cancel();
              if (!location || redirects++ >= 5) throw new RunnerError("other", response.status);
              const next = httpUrl(new URL(location, url).href);
              const headers = new Headers(init?.headers);
              const hasCredential = ["authorization", "x-api-key", "x-subscription-token", "cookie"].some(name => headers.has(name));
              // API endpoints are verified destinations; don't follow a credentialed
              // cross-origin redirect, downgrade HTTPS or replay a POST elsewhere.
              if ((hasCredential && new URL(next).origin !== new URL(url).origin) || (url.startsWith("https:") && !next.startsWith("https:")) || (init?.method && init.method !== "GET" && init.method !== "HEAD")) throw new RunnerError("other", response.status);
              url = next;
              continue;
            }
            return response;
          }
        } finally { release(); }
      };
    },
  };
}
