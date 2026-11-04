// ============================================================
// PRAANA — Connect and idle timeouts for streaming LLM fetches
// ============================================================

import type { AssistantMessage, StreamEvent, StreamRequest } from "./types.js";
import { isDefaultHostedEndpoint } from "./stream-end.js";
import { withPreEmissionRetry } from "./retry.js";

/** Connect budget for first-party hosted providers. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
/** Connect budget for local, self-hosted, and other registry providers. */
export const DEFAULT_LOCAL_CONNECT_TIMEOUT_MS = 300_000;
/** Idle budget for every provider. Server silence, not time-to-first-byte. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
/**
 * After a sentinel that still has a known trailer (Bedrock `metadata`,
 * OpenAI usage / `[DONE]`), keep reading until the trailer, the body end,
 * or this long. An idle budget of 0 uses the same cap.
 */
export const TRAILER_GRACE_MS = 2_000;

export function trailerGraceMs(idleTimeoutMs: number): number {
  if (!(idleTimeoutMs > 0)) return TRAILER_GRACE_MS;
  return Math.min(idleTimeoutMs, TRAILER_GRACE_MS);
}

export interface LlmStreamTimeouts {
  connectTimeoutMs: number;
  idleTimeoutMs: number;
}

const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
let pendingListeners = 0;

/**
 * Connect and idle budgets for one request.
 * An explicit number, including `0` (disabled), wins for every provider.
 * Otherwise idle is {@link DEFAULT_STREAM_IDLE_TIMEOUT_MS}. Connect is
 * {@link DEFAULT_CONNECT_TIMEOUT_MS} when {@link isDefaultHostedEndpoint}
 * and {@link DEFAULT_LOCAL_CONNECT_TIMEOUT_MS} otherwise (another host,
 * a user-declared id, or any provider outside the hosted set).
 */
export function resolveLlmStreamTimeouts(opts: {
  provider: string;
  baseUrl?: string;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}): LlmStreamTimeouts {
  const hosted = isDefaultHostedEndpoint(opts.provider, opts.baseUrl);
  return {
    connectTimeoutMs:
      opts.connectTimeoutMs ??
      (hosted ? DEFAULT_CONNECT_TIMEOUT_MS : DEFAULT_LOCAL_CONNECT_TIMEOUT_MS),
    idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  };
}

/**
 * Use budgets already resolved onto the request. Resolve only when a caller
 * invoked a driver directly and left a budget unset.
 */
export function timeoutsFromRequest(req: StreamRequest): LlmStreamTimeouts {
  if (typeof req.connectTimeoutMs === "number" && typeof req.idleTimeoutMs === "number") {
    return { connectTimeoutMs: req.connectTimeoutMs, idleTimeoutMs: req.idleTimeoutMs };
  }
  return resolveLlmStreamTimeouts({
    provider: req.provider,
    baseUrl: req.baseUrl,
    connectTimeoutMs: req.connectTimeoutMs,
    idleTimeoutMs: req.idleTimeoutMs,
  });
}

export function streamGuardPendingTimers(): number {
  return pendingTimers.size;
}

export function streamGuardPendingListeners(): number {
  return pendingListeners;
}

/**
 * Shared fetch + body-guard lifecycle for the protocol drivers.
 * Owns the connect/idle guard, the non-OK body read, abort/idle `done`
 * events, and disposal. Drivers only parse frames.
 */
export async function* runGuardedProviderStream<T>(opts: {
  req: StreamRequest;
  haltedMessage: () => AssistantMessage;
  httpErrorLabel: string;
  emptyBodyMessage: string;
  request: (guard: LlmFetchGuard) => Promise<Response>;
  frames: (body: ReadableStream<Uint8Array>) => AsyncIterable<T>;
  /**
   * `stop` ends the read now. `awaitTrailer` and `releaseIfIdle` keep reading
   * until the driver stops, the body ends, or {@link trailerGraceMs} elapses.
   */
  onFrame: (frame: T) => {
    events: StreamEvent[];
    stop?: boolean;
    /** Same trailer wait as `awaitTrailer`. OpenAI-compatible drivers set this after `finish_reason`. */
    releaseIfIdle?: boolean;
    /** Keep reading until the driver stops, the body ends, or {@link trailerGraceMs}. */
    awaitTrailer?: boolean;
  };
  onComplete: () => StreamEvent[];
}): AsyncGenerator<StreamEvent> {
  const timeouts = timeoutsFromRequest(opts.req);
  const guard = createLlmFetchGuard({
    userSignal: opts.req.signal,
    connectTimeoutMs: timeouts.connectTimeoutMs,
    idleTimeoutMs: timeouts.idleTimeoutMs,
  });

  const errorEvent = (err: unknown): StreamEvent => {
    const status = (err as { status?: number }).status;
    return {
      type: "error",
      error: err instanceof Error ? err : new Error(String(err)),
      status,
      retryable: false,
      ...(err instanceof ConnectTimeoutError ? { kind: "connect_timeout" as const } : {}),
    };
  };

  let response: Response;
  try {
    response = await withPreEmissionRetry(
      async () => {
        const res = await opts.request(guard);
        if (!res.ok) {
          let errText = "";
          try {
            errText = await readErrorBody(res, errorBodyTimeoutMs(timeouts.idleTimeoutMs));
          } catch {
            errText = "response body timed out";
          }
          const err: Error & { status?: number; headers?: Headers } = new Error(
            `${opts.httpErrorLabel} (${res.status}): ${errText}`,
          );
          err.status = res.status;
          err.headers = res.headers;
          throw err;
        }
        if (!res.body) throw new Error(opts.emptyBodyMessage);
        return res;
      },
      {
        signal: opts.req.signal,
        maxRetriesFor: (err) => (err instanceof ConnectTimeoutError ? 1 : undefined),
      },
    );
  } catch (err) {
    guard.dispose();
    const halted = streamGuardTerminal(
      guard.abortKind(),
      Boolean(opts.req.signal?.aborted),
      opts.haltedMessage(),
    );
    if (halted) {
      yield halted;
      return;
    }
    yield errorEvent(err);
    return;
  }

  const haltNow = (): StreamEvent | null =>
    streamGuardTerminal(guard.abortKind(), Boolean(opts.req.signal?.aborted), opts.haltedMessage());

  const yieldHalt = (): StreamEvent | null => {
    if (opts.req.signal?.aborted || guard.abortKind() === "user" || guard.abortKind() === "idle") {
      return haltNow();
    }
    return null;
  };

  const frames = opts.frames(guard.wrapBody(response.body!))[Symbol.asyncIterator]();
  const pullFrame = () => frames.next();
  try {
    while (true) {
      const nxt = await pullFrame();
      if (nxt.done) break;
      const halted = yieldHalt();
      if (halted) {
        yield halted;
        return;
      }
      const step = opts.onFrame(nxt.value);
      for (const ev of step.events) yield ev;
      if (step.stop) return;
      if (step.awaitTrailer || step.releaseIfIdle) {
        const deadline = Date.now() + trailerGraceMs(timeouts.idleTimeoutMs);
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const pending = pullFrame();
          const framePromise = pending.then((r) => ({ idle: false as const, r }));
          framePromise.catch(() => {});
          let timer: ReturnType<typeof setTimeout> | null = null;
          let raced: { idle: true } | { idle: false; r: IteratorResult<T> };
          try {
            raced = await Promise.race([
              framePromise,
              new Promise<{ idle: true }>((resolve) => {
                timer = schedule(Math.max(0, remaining), () => resolve({ idle: true }));
              }),
            ]);
          } catch {
            // The provider already sent its terminal. A later socket error is
            // the body ending, unless the user or the idle timer already halted.
            clearScheduled(timer);
            break;
          }
          clearScheduled(timer);
          if (raced.idle) {
            guard.dispose();
            await pending.catch(() => {});
            break;
          }
          if (raced.r.done) break;
          const during = yieldHalt();
          if (during) {
            yield during;
            return;
          }
          const more = opts.onFrame(raced.r.value);
          for (const ev of more.events) yield ev;
          if (more.stop) return;
        }
        const afterTrailer = yieldHalt();
        if (afterTrailer) {
          yield afterTrailer;
          return;
        }
        for (const ev of opts.onComplete()) yield ev;
        return;
      }
    }
    const halted = yieldHalt();
    if (halted) {
      yield halted;
      return;
    }
    for (const ev of opts.onComplete()) yield ev;
  } catch (err) {
    const halted = yieldHalt();
    if (halted) {
      yield halted;
      return;
    }
    yield errorEvent(err);
  } finally {
    // return() waits behind an in-flight next(). Cancel the body first so
    // that pull settles instead of holding the turn for the idle budget.
    guard.dispose();
    await frames.return?.().catch(() => {});
  }
}

/** Bound for reading a non-OK response body after headers have arrived. */
export const ERROR_BODY_TIMEOUT_MS = 15_000;
/** Stop reading a non-OK body after this many bytes. */
export const ERROR_BODY_MAX_BYTES = 64 * 1024;

export function errorBodyTimeoutMs(idleTimeoutMs: number): number {
  if (idleTimeoutMs > 0) return Math.min(idleTimeoutMs, ERROR_BODY_TIMEOUT_MS);
  return ERROR_BODY_TIMEOUT_MS;
}

/**
 * Read an error response body, or throw if it stays silent past `timeoutMs`.
 * The deadline is computed once for the whole read. A trickling body does not
 * reset it. The read also stops after {@link ERROR_BODY_MAX_BYTES}.
 * Callers should report the HTTP status plus "response body timed out".
 */
export async function readErrorBody(res: Response, timeoutMs = ERROR_BODY_TIMEOUT_MS): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Error("response body timed out");
  const deadline = timeoutMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  try {
    while (received < ERROR_BODY_MAX_BYTES) {
      const remaining = deadline - Date.now();
      if (timeoutMs !== 0 && remaining <= 0) throw timedOut;
      const readPromise = reader.read();
      readPromise.catch(() => {});
      const result = timeoutMs === 0
        ? await readPromise
        : await Promise.race([
            readPromise,
            new Promise<never>((_, reject) => {
              timer = schedule(remaining, () => reject(timedOut));
            }),
          ]);
      clearScheduled(timer);
      timer = null;
      if (result.done) break;
      const room = ERROR_BODY_MAX_BYTES - received;
      const value = result.value.byteLength > room ? result.value.subarray(0, room) : result.value;
      chunks.push(value);
      received += value.byteLength;
    }
    if (received >= ERROR_BODY_MAX_BYTES) await reader.cancel().catch(() => {});
    return Buffer.concat(chunks).toString("utf8");
  } catch (err) {
    clearScheduled(timer);
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    clearScheduled(timer);
  }
}

/** Retryable failure: response headers did not arrive within the connect budget. */
export class ConnectTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`ETIMEDOUT: connect timeout after ${timeoutMs}ms (llm.connect_timeout_ms)`);
    this.name = "ConnectTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export type StreamAbortKind = "user" | "connect" | "idle";

export interface LlmFetchGuard {
  fetch(input: RequestInfo | URL, init: RequestInit): Promise<Response>;
  wrapBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
  abortKind(): StreamAbortKind | null;
  dispose(): void;
}

export function streamGuardTerminal(
  kind: StreamAbortKind | null,
  userAborted: boolean,
  message: AssistantMessage,
): Extract<StreamEvent, { type: "done" }> | null {
  if (userAborted || kind === "user") {
    return { type: "done", reason: "abort", message };
  }
  if (kind === "idle") {
    return { type: "done", reason: "timeout", message };
  }
  return null;
}

function schedule(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    fn();
  }, ms);
  pendingTimers.add(timer);
  return timer;
}

function clearScheduled(timer: ReturnType<typeof setTimeout> | null): void {
  if (!timer) return;
  clearTimeout(timer);
  pendingTimers.delete(timer);
}

/**
 * AbortSignal.any is present in this Bun, but its dependent abort algorithms
 * stay on the caller's signal until that signal itself aborts. A turn-scoped
 * signal would keep one algorithm per request. The guard links the user
 * signal with addEventListener and removes it in dispose().
 */
export function createLlmFetchGuard(opts: {
  userSignal?: AbortSignal;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
}): LlmFetchGuard {
  const userSignal = opts.userSignal;
  let controller: AbortController | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let kind: StreamAbortKind | null = null;
  let onUserAbort: (() => void) | null = null;
  let disposed = false;
  let attempt = 0;
  let bodyReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let bodyDone = false;

  const unlinkUser = (): void => {
    if (!userSignal || !onUserAbort) return;
    userSignal.removeEventListener("abort", onUserAbort);
    onUserAbort = null;
    pendingListeners -= 1;
  };

  const linkUser = (target: AbortController): void => {
    unlinkUser();
    if (!userSignal) return;
    if (userSignal.aborted) {
      if (!kind) kind = "user";
      target.abort(userSignal.reason);
      return;
    }
    onUserAbort = () => {
      if (!kind) kind = "user";
      target.abort(userSignal.reason);
    };
    userSignal.addEventListener("abort", onUserAbort);
    pendingListeners += 1;
  };

  const clearIdle = (): void => {
    clearScheduled(idleTimer);
    idleTimer = null;
  };

  const armIdle = (): void => {
    clearIdle();
    if (opts.idleTimeoutMs === 0 || !controller || disposed) return;
    const target = controller;
    const generation = attempt;
    idleTimer = schedule(opts.idleTimeoutMs, () => {
      idleTimer = null;
      if (disposed || generation !== attempt || kind) return;
      kind = "idle";
      target.abort();
    });
  };

  return {
    async fetch(input, init) {
      if (disposed) {
        throw new Error("LLM stream guard was disposed before fetch");
      }
      attempt += 1;
      clearScheduled(connectTimer);
      connectTimer = null;
      clearIdle();
      unlinkUser();
      if (kind !== "user") kind = null;

      const target = new AbortController();
      controller = target;
      linkUser(target);
      if (userSignal?.aborted || kind === "user") {
        kind = "user";
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      if (opts.connectTimeoutMs > 0) {
        const generation = attempt;
        connectTimer = schedule(opts.connectTimeoutMs, () => {
          connectTimer = null;
          if (disposed || generation !== attempt || kind) return;
          kind = "connect";
          target.abort();
        });
      }

      try {
        const res = await globalThis.fetch(input, { ...init, signal: target.signal });
        clearScheduled(connectTimer);
        connectTimer = null;
        return res;
      } catch (err) {
        clearScheduled(connectTimer);
        connectTimer = null;
        if (userSignal?.aborted) {
          kind = "user";
          throw err;
        }
        if (kind === "connect") {
          throw new ConnectTimeoutError(opts.connectTimeoutMs);
        }
        throw err;
      }
    },

    wrapBody(body) {
      const reader = body.getReader();
      bodyReader = reader;
      // highWaterMark 0: pull only to satisfy the consumer's read. A default
      // watermark of 1 pulls the next chunk as soon as the previous one is
      // delivered, which would re-arm the idle timer while the consumer is
      // still working.
      return new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          // Measure server silence only. Arm while waiting on upstream, then
          // pause as soon as a chunk arrives so a slow consumer cannot trip
          // the idle timer on a healthy connection. The next pull starts a
          // fresh window; the previous chunk just arrived.
          armIdle();
          try {
            const { done, value } = await reader.read();
            clearIdle();
            if (done) {
              bodyDone = true;
              ctrl.close();
              return;
            }
            ctrl.enqueue(value);
          } catch (err) {
            clearIdle();
            ctrl.error(err);
          }
        },
        async cancel(reason) {
          clearIdle();
          await reader.cancel(reason);
        },
      }, { highWaterMark: 0 });
    },

    abortKind() {
      return kind;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      clearScheduled(connectTimer);
      connectTimer = null;
      clearIdle();
      unlinkUser();
      if (bodyDone) return;
      if (controller && !controller.signal.aborted) controller.abort();
      const reader = bodyReader;
      bodyReader = null;
      if (reader) void reader.cancel().catch(() => {});
    },
  };
}
