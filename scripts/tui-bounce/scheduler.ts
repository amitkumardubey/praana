import type { StreamBatchScheduler } from "../../src/ui/tui/sink.js";

interface Timer {
  at: number;
  fn: () => void;
  cleared: boolean;
}

/**
 * Leading-edge batch clock for OpenTuiSink. Time moves only when the harness
 * calls `advance`, so a 33ms batch does not wait on the wall clock.
 */
export class ManualBatchScheduler implements StreamBatchScheduler {
  now = 0;
  private timers: Timer[] = [];

  schedule(fn: () => void, ms: number): { clear(): void } {
    const timer: Timer = { at: this.now + ms, fn, cleared: false };
    this.timers.push(timer);
    return {
      clear: () => {
        timer.cleared = true;
      },
    };
  }

  /** Move the clock forward. Returns how many callbacks ran. */
  advance(ms: number): number {
    if (ms < 0) throw new Error("cannot advance the batch clock backwards");
    this.now += ms;
    let fired = 0;
    for (;;) {
      let next: Timer | null = null;
      for (const timer of this.timers) {
        if (timer.cleared || timer.at > this.now) continue;
        if (!next || timer.at < next.at) next = timer;
      }
      if (!next) break;
      next.cleared = true;
      fired++;
      next.fn();
    }
    return fired;
  }
}
