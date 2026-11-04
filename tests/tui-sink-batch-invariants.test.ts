import {
  BATCH_MS,
  SEEDS,
  CORRECT,
  generateOps,
  makePair,
  mulberry32,
  feedOp,
  naiveBatched,
  realBatched,
  removalFailureKinds,
  runScenario,
  snapshotStore,
} from "./helpers/tui-sink-batch-harness.js";
import { OpenTuiSink } from "../src/ui/tui/sink.js";
import { TranscriptProjection } from "../src/ui/tui/transcript/projection.js";
import type { ToastApi } from "../src/ui/tui/shell-ui.js";

describe("batched sink invariants (seeded)", () => {
  it("I1-I4 hold across 300 seeded interleavings", async () => {
    const agg = new Map<string, number>();
    for (let seed = 0; seed < SEEDS; seed++) {
      // Yield periodically so the event loop stays responsive (the loop is
      // otherwise fully synchronous).
      if (seed % 25 === 0) await new Promise((r) => setImmediate(r));
      const ops = generateOps(mulberry32(seed), 70);
      for (const f of runScenario(seed, BATCH_MS, ops, realBatched)) {
        agg.set(f, (agg.get(f) ?? 0) + 1);
      }
    }
    expect(agg.size).toBe(0);
  });

  it("I5: batch 0 is a pure pass-through at every step", () => {
    for (let seed = 0; seed < 60; seed++) {
      const rand = mulberry32(seed + 5000);
      const ops = generateOps(rand, 60);
      const p = makePair(0, (mount, persist, scheduler) =>
        new OpenTuiSink(mount, {} as unknown as ToastApi, {
          ambient: "inline",
          showThinking: () => true,
          onSpinnerMessage: () => {},
          ctxWindowTokens: 128_000,
          engineMode: false,
          projection: new TranscriptProjection({ useUnicode: false }),
          persistEntry: persist as (e: never) => void,
          streamBatchMs: 0,
          batchScheduler: scheduler,
        }),
      );
      for (const op of ops) {
        feedOp(p, op, 0, rand);
        if (op.kind !== "advance") {
          expect(JSON.stringify(snapshotStore(p.batchedStore))).toBe(
            JSON.stringify(snapshotStore(p.refStore)),
          );
        }
      }
      expect(JSON.stringify(p.batchedPersist)).toBe(JSON.stringify(p.refPersist));
    }
  });
});

describe("removal checks (seeded sensitivity)", () => {
  it("the correct naive configuration passes", () => {
    const agg = removalFailureKinds(CORRECT, 60);
    expect(agg.size).toBe(0);
  });

  it("removing flush-before-events fails I2 (event applied while text pending)", () => {
    const agg = removalFailureKinds({ ...CORRECT, flushBeforeEvents: false }, 60);
    expect([...agg.keys()].some((k) => k.includes("I2"))).toBe(true);
  });

  it("removing flush-on-stream-change fails I2 (cross-stream merge)", () => {
    const agg = removalFailureKinds({ ...CORRECT, flushOnStreamChange: false }, 60);
    expect([...agg.keys()].some((k) => k.includes("I2"))).toBe(true);
  });

  it("removing flush-on-dispose fails I1/I4 (pending text lost)", () => {
    const agg = removalFailureKinds({ ...CORRECT, flushOnDispose: false }, 60);
    expect([...agg.keys()].some((k) => k.includes("I1") || k.includes("I4"))).toBe(true);
  });

  it("removing timer clear fails I4 (stale/concurrent timers)", () => {
    const agg = removalFailureKinds({ ...CORRECT, clearTimerOnFlush: false }, 60);
    expect([...agg.keys()].some((k) => k.includes("I4"))).toBe(true);
  });

  it("trailing debounce (leading-edge removed) fails I3 (mid-stream liveness)", () => {
    const agg = removalFailureKinds({ ...CORRECT, trailing: true }, 60);
    expect([...agg.keys()].some((k) => k.includes("I3"))).toBe(true);
  });

  it("the classic naive version (trailing + no flush-before-tool) fails", () => {
    const agg = removalFailureKinds({ ...CORRECT, trailing: true, flushBeforeEvents: false }, 60);
    expect(agg.size).toBeGreaterThan(0);
  });
});
