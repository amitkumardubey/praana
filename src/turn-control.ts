import * as readline from "node:readline";

/** Max gap between Esc presses to count as a double-tap interrupt. */
export const ESC_INTERRUPT_WINDOW_MS = 600;

/** Delay before treating a lone ESC byte as a keypress (not an arrow/function prefix). */
export const ESC_SEQUENCE_DEFER_MS = 30;

export function nextEscapeInterruptState(
  lastEscAt: number,
  now: number,
  windowMs = ESC_INTERRUPT_WINDOW_MS
): { lastEscAt: number; triggered: boolean } {
  if (lastEscAt > 0 && now - lastEscAt <= windowMs) {
    return { lastEscAt: 0, triggered: true };
  }
  return { lastEscAt: now, triggered: false };
}

function isAnsiFinalByte(byte: number): boolean {
  return byte >= 0x40 && byte <= 0x7e;
}

/** Skip an ANSI/SS3 escape sequence starting at `start` (on the ESC byte). */
export function skipEscapeSequence(chunk: Buffer, start: number): number {
  let i = start + 1;
  if (i >= chunk.length) return chunk.length;
  const lead = chunk[i];
  if (lead !== 0x5b && lead !== 0x4f) return i; // not CSI/SS3
  i++;
  while (i < chunk.length && !isAnsiFinalByte(chunk[i])) i++;
  if (i < chunk.length) i++;
  return i;
}

export function chunkContainsCtrlC(chunk: Buffer): boolean {
  return chunk.includes(0x03);
}

export function consumeEscapeBytes(
  chunk: Buffer,
  lastEscAt: number,
  now: number,
  windowMs = ESC_INTERRUPT_WINDOW_MS
): { lastEscAt: number; triggered: boolean; deferred: boolean } {
  let last = lastEscAt;
  let triggered = false;
  let deferred = false;
  let i = 0;

  while (i < chunk.length) {
    if (chunk[i] !== 0x1b) {
      i++;
      continue;
    }

    if (chunk[i + 1] === 0x1b) {
      triggered = true;
      last = 0;
      i += 2;
      continue;
    }

    if (chunk[i + 1] === 0x5b || chunk[i + 1] === 0x4f) {
      i = skipEscapeSequence(chunk, i);
      continue;
    }

    if (chunk[i + 1] !== undefined) {
      // Alt/meta combo — not a standalone Esc.
      i += 2;
      continue;
    }

    deferred = true;
    i++;
  }

  return { lastEscAt: last, triggered, deferred };
}

/** Listens for Esc Esc while a turn is running. */
export class EscInterruptListener {
  private lastEscAt = 0;
  private dataHandler: ((chunk: Buffer) => void) | null = null;
  private active = false;
  private priorRawMode: boolean | null = null;
  private rl: readline.Interface | null = null;
  private savedWrite: readline.Interface["write"] | null = null;
  private deferTimer: ReturnType<typeof setTimeout> | null = null;
  private onInterrupt: (() => void) | null = null;

  start(onInterrupt: () => void, rl?: readline.Interface): void {
    if (!process.stdin.isTTY || this.active) return;
    this.active = true;
    this.lastEscAt = 0;
    this.onInterrupt = onInterrupt;
    this.rl = rl ?? null;

    if (this.rl) {
      this.savedWrite = this.rl.write.bind(this.rl);
      this.rl.write = (() => true) as readline.Interface["write"];
      this.rl.pause();
    }

    this.priorRawMode = process.stdin.isRaw ?? false;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    this.dataHandler = (chunk: Buffer) => this.handleData(chunk);
    process.stdin.on("data", this.dataHandler);
  }

  private handleData(chunk: Buffer): void {
    if (!this.onInterrupt) return;

    if (chunkContainsCtrlC(chunk)) {
      this.clearDeferTimer();
      this.onInterrupt();
      return;
    }

    if (this.deferTimer && chunk.length > 0) {
      const lead = chunk[0];
      if (lead === 0x5b || lead === 0x4f) {
        clearTimeout(this.deferTimer);
        this.deferTimer = null;
        this.consumeAnsiContinuation(chunk);
        return;
      }
    }

    const now = Date.now();
    const parsed = consumeEscapeBytes(chunk, this.lastEscAt, now);
    this.lastEscAt = parsed.lastEscAt;
    if (parsed.triggered) {
      this.clearDeferTimer();
      this.onInterrupt();
      return;
    }

    if (parsed.deferred) {
      this.clearDeferTimer();
      this.deferTimer = setTimeout(() => {
        this.deferTimer = null;
        if (!this.onInterrupt) return;
        const next = nextEscapeInterruptState(this.lastEscAt, Date.now());
        this.lastEscAt = next.lastEscAt;
        if (next.triggered) this.onInterrupt();
      }, ESC_SEQUENCE_DEFER_MS);
    }
  }

  private consumeAnsiContinuation(chunk: Buffer): void {
    let i = 0;
    while (i < chunk.length) {
      if (chunk[i] === 0x5b || chunk[i] === 0x4f) {
        i++;
        while (i < chunk.length && !isAnsiFinalByte(chunk[i])) i++;
        if (i < chunk.length) i++;
        continue;
      }
      i++;
    }
  }

  private clearDeferTimer(): void {
    if (!this.deferTimer) return;
    clearTimeout(this.deferTimer);
    this.deferTimer = null;
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.clearDeferTimer();

    if (this.dataHandler) {
      process.stdin.removeListener("data", this.dataHandler);
      this.dataHandler = null;
    }

    if (process.stdin.isTTY && this.priorRawMode !== null) {
      process.stdin.setRawMode(this.priorRawMode);
    }
    this.priorRawMode = null;

    if (this.rl && this.savedWrite) {
      this.rl.write = this.savedWrite;
      this.savedWrite = null;
      this.rl.resume();
      this.rl = null;
    }

    this.onInterrupt = null;
    this.lastEscAt = 0;
  }
}

/** Tracks and aborts the currently running turn (LLM stream / tool execution). */
export class TurnController {
  private controller: AbortController | null = null;
  private active = false;

  /** Start a new turn; aborts any previous in-flight turn. */
  begin(): AbortSignal {
    this.active = true;
    this.controller?.abort();
    this.controller = new AbortController();
    return this.controller.signal;
  }

  /** Whether a turn lifecycle is open (between begin() and end()). */
  isActive(): boolean {
    return this.active;
  }

  /** Abort the in-flight turn. No-op if already aborted or ended. */
  abort(): void {
    if (!this.controller || this.controller.signal.aborted) return;
    this.controller.abort();
  }

  get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }

  get inProgress(): boolean {
    return this.active && this.controller !== null && !this.controller.signal.aborted;
  }

  end(): void {
    this.active = false;
    this.controller = null;
  }
}

export class TurnAbortedError extends Error {
  readonly partialResponse: string;

  constructor(partialResponse = "") {
    super("Turn interrupted");
    this.name = "TurnAbortedError";
    this.partialResponse = partialResponse;
  }
}
