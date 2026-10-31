// ============================================================
// PRAANA — Connect and idle timeouts for streaming LLM fetches
// ============================================================

import type { AssistantMessage, StreamEvent, StreamRequest } from "./types.js";
import { STREAM_END_STRICT_PROVIDERS } from "./stream-end.js";
import { isUserDeclaredProvider } from "../provider-registry.js";
import { withPreEmissionRetry } from "./retry.js";

/** Connect budget for first-party hosted providers. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
/** Connect budget for local, self-hosted, and other registry providers. */
export const DEFAULT_LOCAL_CONNECT_TIMEOUT_MS = 300_000;
/** Idle budget for every provider. Server silence, not time-to-first-byte. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

export interface LlmStreamTimeouts {
  connectTimeoutMs: number;
  idleTimeoutMs: number;
}

let configured: LlmStreamTimeouts = {
  connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
  idleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
};

const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
let pendingListeners = 0;

/**
 * AbortSignal.any is present in this Bun, but its dependent abort algorithms
 * stay on the caller's signal until that signal itself aborts. A turn-scoped
 * signal would keep one algorithm per request. The guard links the user
 * signal with addEventListener and removes it in dispose().
 */
export function setLlmStreamTimeouts(next: LlmStreamTimeouts): void {
  configured = {
    connectTimeoutMs: next.connectTimeoutMs,
    idleTimeoutMs: next.idleTimeoutMs,
  };
}

export function getLlmStreamTimeouts(): LlmStreamTimeouts {
  return { ...configured };
}

/**
 * Connect and idle budgets for one request.
 * An explicit number, including `0` (disabled), wins for every provider.
 * Otherwise idle is {@link DEFAULT_STREAM_IDLE_TIMEOUT_MS}. Connect is
 * {@link DEFAULT_CONNECT_TIMEOUT_MS} for the first-party hosted set
 * ({@link STREAM_END_STRICT_PROVIDERS}) and {@link DEFAULT_LOCAL_CONNECT_TIMEOUT_MS}
 * for everyone else, including user-declared endpoints that reuse a hosted id.
 */
export function resolveLlmStreamTimeouts(opts: {
  provider: string;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}): LlmStreamTimeouts {
  const hosted =
    !isUserDeclaredProvider(opts.provider) && STREAM_END_STRICT_PROVIDERS.has(opts.provider);
  return {
    connectTimeoutMs:
      opts.connectTimeoutMs ??
      (hosted ? DEFAULT_CONNECT_TIMEOUT_MS : DEFAULT_LOCAL_CONNECT_TIMEOUT_MS),
    idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  };
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
  onFrame: (frame: T) => { events: StreamEvent[]; stop?: boolean };
  onComplete: () => StreamEvent[];
}): AsyncGenerator<StreamEvent> {
  const timeouts = resolveLlmStreamTimeouts({
    provider: opts.req.provider,
    connectTimeoutMs: opts.req.connectTimeoutMs,
    idleTimeoutMs: opts.req.idleTimeoutMs,
  });
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
          const err: Error & { status?: number } = new Error(
            `${opts.httpErrorLabel} (${res.status}): ${errText}`,
          );
          err.status = res.status;
          throw err;
        }
        if (!res.body) throw new Error(opts.emptyBodyMessage);
        return res;
      },
      { signal: opts.req.signal },
    );
  } catch (err) {
    guard.dispose();
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

  try {
    for await (const frame of opts.frames(guard.wrapBody(response.body!))) {
      const halted = yieldHalt();
      if (halted) {
        yield halted;
        return;
      }
      const step = opts.onFrame(frame);
      for (const ev of step.events) yield ev;
      if (step.stop) return;
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
    guard.dispose();
  }
}

/** Bound for reading a non-OK response body after headers have arrived. */
export const ERROR_BODY_TIMEOUT_MS = 15_000;

export function errorBodyTimeoutMs(idleTimeoutMs: number): number {
  if (idleTimeoutMs > 0) return Math.min(idleTimeoutMs, ERROR_BODY_TIMEOUT_MS);
  return ERROR_BODY_TIMEOUT_MS;
}

/**
 * Read an error response body, or throw if it stays silent past `timeoutMs`.
 * Callers should report the HTTP status plus "response body timed out".
 */
export async function readErrorBody(res: Response, timeoutMs = ERROR_BODY_TIMEOUT_MS): Promise<string> {
  if (!res.body) return "";
  if (timeoutMs === 0) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Error("response body timed out");
  try {
    while (true) {
      const readPromise = reader.read();
      readPromise.catch(() => {});
      const result = await Promise.race([
        readPromise,
        new Promise<never>((_, reject) => {
          timer = schedule(timeoutMs, () => reject(timedOut));
        }),
      ]);
      clearScheduled(timer);
      timer = null;
      if (result.done) break;
      chunks.push(result.value);
    }
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
    },
  };
}
