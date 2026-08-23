import { describe, expect, it } from "bun:test";
import { createConfirmLock } from "../src/risk/confirm-lock.js";

describe("createConfirmLock", () => {
  it("runs overlapping calls in start order", async () => {
    const lock = createConfirmLock();
    const order: number[] = [];
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const a = lock(async () => {
      await wait(30);
      order.push(1);
      return 1;
    });
    const b = lock(async () => {
      order.push(2);
      return 2;
    });
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(order).toEqual([1, 2]);
  });

  it("releases the lock when the first call rejects", async () => {
    const lock = createConfirmLock();
    const first = lock(async () => {
      throw new Error("boom");
    });
    const second = lock(async () => "ok");
    await expect(first).rejects.toThrow("boom");
    expect(await second).toBe("ok");
  });
});
