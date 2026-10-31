// ============================================================
// PRAANA — Connect and idle timeouts for streaming LLM fetches
// ============================================================

import type { AssistantMessage, StreamEvent } from "./types.js";

export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

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

export function streamGuardPendingTimers(): number {
  return pendingTimers.size;
}

export function streamGuardPendingListeners(): number {
  return pendingListeners;
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
      armIdle();
      const reader = body.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              clearIdle();
              ctrl.close();
              return;
            }
            armIdle();
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
      });
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
