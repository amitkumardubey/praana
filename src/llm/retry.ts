// ============================================================
// PRAANA — Pre-Emission Retry Handler
// ============================================================

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
}

/**
 * Determine whether an HTTP status code or Error is retryable.
 * Only transport, connection reset, timeout, 429, and 5xx errors are retryable.
 */
export function isRetryableError(error: unknown, status?: number): boolean {
  if (status !== undefined) {
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
      return true;
    }
    // 400, 401, 403, 404, 422 are permanent client errors
    return false;
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("fetch failed") ||
      msg.includes("network") ||
      msg.includes("overloaded")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Parse standard Retry-After header (seconds or HTTP date).
 */
export function parseRetryAfterHeader(headerVal: string | null | undefined): number | null {
  if (!headerVal) return null;
  const asNum = Number.parseInt(headerVal, 10);
  if (!Number.isNaN(asNum) && asNum >= 0) {
    return asNum * 1000;
  }
  const asDate = Date.parse(headerVal);
  if (!Number.isNaN(asDate)) {
    const diff = asDate - Date.now();
    return Math.max(0, diff);
  }
  return null;
}

/**
 * Execute an async network operation with pre-emission retry safety.
 *
 * INVARIANT: If the callback fails BEFORE emitting any observable stream deltas,
 * it can be retried with exponential backoff.
 */
export async function withPreEmissionRetry<T>(
  operation: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelay = opts.baseDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 10000;

  let attempt = 0;

  while (true) {
    if (opts.signal?.aborted) {
      throw new Error("Operation aborted");
    }

    try {
      return await operation(attempt);
    } catch (err: any) {
      attempt++;
      const status = err.status ?? (err.response ? err.response.status : undefined);

      if (attempt > maxRetries || !isRetryableError(err, status)) {
        throw err;
      }

      // Calculate backoff
      const retryAfterMs = parseRetryAfterHeader(err.headers?.get?.("retry-after"));
      const jitter = Math.random() * 200;
      const calculatedBackoff = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1) + jitter);
      const delayMs = retryAfterMs !== null ? Math.min(maxDelay, retryAfterMs) : calculatedBackoff;

      await sleep(delayMs, opts.signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error("Operation aborted"));
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Operation aborted"));
    });
  });
}
