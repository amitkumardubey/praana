/**
 * Solid overlay state machine (Phase 3/5).
 *
 * A pending step-pause confirm takes priority: other show* calls wait until
 * it resolves or its signal aborts, and they do not count as "stop".
 * A confirm requested while another overlay is open waits for that overlay
 * to close. Each confirm listens to its own signal. A later non-confirm
 * request does not settle a queued confirm.
 *
 * Interleaving invariants:
 * O1 every showConfirm promise settles exactly once
 * O2 no overlay request is lost and none is resolved as a side effect of another
 * O3 a displaced/queued overlay's own callbacks fire exactly once
 *    (an open overlay stays up across a confirm request, so its cancel is
 *    not skipped; a queued overlay opens later, once)
 * O4 at the end of any interleaving kind is "none" or a legitimately open
 *    queued overlay, never a stale "confirm"
 * O5 abort at any point settles the aborted confirm without leaving it queued
 */
import { describe, expect, it } from "bun:test";
import { createOverlayUi } from "../src/ui/tui/overlays/state.js";

describe("createOverlayUi", () => {
  it("cycles slash / model / login / logout and dismisses", () => {
    const ui = createOverlayUi();
    expect(ui.kind()).toBe("none");

    ui.showSlash(["a", "b"]);
    expect(ui.kind()).toBe("slash");
    expect(ui.slashLines()).toEqual(["a", "b"]);

    ui.showModel();
    expect(ui.kind()).toBe("model");

    ui.showLogin("anthropic");
    expect(ui.kind()).toBe("login");
    expect(ui.loginHint()).toBe("anthropic");

    ui.showLogout("claude");
    expect(ui.kind()).toBe("logout");
    expect(ui.logoutHint()).toBe("claude");

    ui.showPalette();
    expect(ui.kind()).toBe("palette");

    ui.dismiss();
    expect(ui.kind()).toBe("none");
    expect(ui.slashLines()).toEqual([]);
    expect(ui.loginHint()).toBeUndefined();
    expect(ui.logoutHint()).toBeUndefined();
    ui.dispose();
  });

  async function settled(pending: Promise<boolean>): Promise<{ settled: true; value: boolean } | { settled: false }> {
    return Promise.race([
      pending.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolve) => {
        setTimeout(() => resolve({ settled: false }), 30);
      }),
    ]);
  }

  it("keeps a step-pause confirm in front of other overlays until it is answered", async () => {
    const ui = createOverlayUi();
    const pending = ui.showConfirm("continue?");
    ui.showSlash(["later"]);
    ui.showModel();
    expect(ui.kind()).toBe("confirm");
    expect(ui.confirmPrompt()?.message).toBe("continue?");
    expect(await settled(pending)).toEqual({ settled: false });

    ui.resolveConfirm(true);
    expect(await pending).toBe(true);
    expect(ui.kind()).toBe("model");
    ui.dispose();
  });

  it("runs a queued confirm after the one that is already open", async () => {
    const ui = createOverlayUi();
    const first = ui.showConfirm("first?");
    const second = ui.showConfirm("second?");
    expect(ui.kind()).toBe("confirm");
    expect(ui.confirmPrompt()?.message).toBe("first?");
    expect(await settled(second)).toEqual({ settled: false });

    ui.resolveConfirm(true);
    expect(await first).toBe(true);
    expect(ui.kind()).toBe("confirm");
    expect(ui.confirmPrompt()?.message).toBe("second?");
    ui.resolveConfirm(false);
    expect(await second).toBe(false);
    expect(ui.kind()).toBe("none");
    ui.dispose();
  });

  it("closes the confirm when its signal aborts and then opens the deferred overlay", async () => {
    const ui = createOverlayUi();
    const abort = new AbortController();
    const pending = ui.showConfirm("continue?", abort.signal);
    ui.showLogin("anthropic");
    expect(ui.kind()).toBe("confirm");
    abort.abort();
    expect(await pending).toBe(false);
    expect(ui.kind()).toBe("login");
    expect(ui.loginHint()).toBe("anthropic");
    ui.dispose();
  });

  it("does not open a confirm that is already aborted", async () => {
    const ui = createOverlayUi();
    const abort = new AbortController();
    abort.abort();
    expect(await ui.showConfirm("continue?", abort.signal)).toBe(false);
    expect(ui.kind()).toBe("none");
    ui.dispose();
  });

  it("dismiss and dispose stop the confirm and drop a queued overlay", async () => {
    const ui = createOverlayUi();
    const pending = ui.showConfirm("still open?");
    const queued = ui.showConfirm("queued?");
    ui.showPalette();
    ui.dismiss();
    expect(await pending).toBe(false);
    expect(await queued).toBe(false);
    expect(ui.kind()).toBe("none");

    const disposed = ui.showConfirm("dispose?");
    ui.dispose();
    expect(await disposed).toBe(false);
  });
});

const OVERLAY_KINDS = ["slash", "model", "palette", "login", "logout", "setup"] as const;
type OpenKind = (typeof OVERLAY_KINDS)[number];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function openKind(ui: ReturnType<typeof createOverlayUi>, kind: OpenKind): void {
  if (kind === "slash") ui.showSlash(["later"]);
  else if (kind === "model") ui.showModel();
  else if (kind === "palette") ui.showPalette();
  else if (kind === "login") ui.showLogin("anthropic");
  else if (kind === "logout") ui.showLogout("claude");
  else ui.showSetup();
}

interface ConfirmRec {
  id: number;
  controller: AbortController;
  settles: number;
  value?: boolean;
}

async function flushMicro(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * One seeded interleaving of overlay opens, closes, confirm requests,
 * answers, and aborts. Throws on the first broken invariant.
 */
async function runOverlayInterleave(seed: number): Promise<void> {
  const rng = mulberry32(seed);
  const ui = createOverlayUi();
  const confirms: ConfirmRec[] = [];
  const steps = 8 + Math.floor(rng() * 16);
  let lastPromptId: number | undefined;
  let lastPromptMessage = "";
  const ops: string[] = [];

  const fail = (message: string): never => {
    throw new Error(`seed=${seed} op=${ops.at(-1) ?? "start"} ${message} :: ${ops.join(",")}`);
  };

  try {
    for (let i = 0; i < steps; i++) {
      const roll = rng();
      const beforeKind = ui.kind();
      const beforeSettles = confirms.map((c) => c.settles);

      if (roll < 0.28) {
        const kind = OVERLAY_KINDS[Math.floor(rng() * OVERLAY_KINDS.length)]!;
        ops.push(`open:${kind}`);
        openKind(ui, kind);
        await flushMicro();
        for (let c = 0; c < confirms.length; c++) {
          if (beforeSettles[c] === 0 && confirms[c]!.settles !== 0) {
            fail(`O2 confirm ${c} settled as a side effect of ${kind}`);
          }
        }
      } else if (roll < 0.55) {
        const controller = new AbortController();
        const rec: ConfirmRec = { id: confirms.length, controller, settles: 0 };
        confirms.push(rec);
        ops.push(`confirm:${rec.id}`);
        const pending = ui.showConfirm(`c${rec.id}?`, controller.signal);
        pending.then((value) => {
          rec.settles += 1;
          rec.value = value;
        });
        await flushMicro();
        if (beforeKind !== "none" && beforeKind !== "confirm" && ui.kind() !== beforeKind) {
          fail(`O2/O3 confirm displaced open ${beforeKind} (now ${ui.kind()})`);
        }
        if (beforeKind !== "none" && beforeKind !== "confirm" && rec.settles !== 0) {
          fail("O5 deferred confirm settled before its overlay closed");
        }
      } else if (roll < 0.72) {
        const pending = confirms.filter((c) => c.settles === 0);
        if (pending.length === 0) {
          ops.push("abort:none");
        } else {
          const target = pending[Math.floor(rng() * pending.length)]!;
          ops.push(`abort:${target.id}`);
          target.controller.abort();
          await flushMicro();
          if (target.settles !== 1 || target.value !== false) {
            fail(`O5 confirm ${target.id} abort settled=${target.settles} value=${String(target.value)}`);
          }
          for (const other of confirms) {
            if (other === target || other.controller.signal.aborted) continue;
            if (other.settles !== beforeSettles[other.id]) {
              fail(`O2 abort of ${target.id} settled confirm ${other.id}`);
            }
          }
        }
      } else if (ui.kind() === "confirm") {
        const cont = rng() < 0.5;
        ops.push(cont ? "resolve:yes" : "resolve:no");
        ui.resolveConfirm(cont);
        await flushMicro();
      } else if (ui.kind() !== "none") {
        ops.push("close");
        ui.dismiss();
        await flushMicro();
      } else {
        ops.push("idle");
      }

      for (const c of confirms) {
        if (c.settles > 1) fail(`O1 confirm ${c.id} settled ${c.settles} times`);
      }
      if (ui.kind() === "confirm") {
        const prompt = ui.confirmPrompt();
        if (!prompt) fail("O4 confirm kind without a prompt");
        else {
          const live = confirms.find((c) => `c${c.id}?` === prompt.message && c.settles === 0);
          if (!live) fail(`O4 stale confirm ${prompt.message}`);
          if (prompt.message !== lastPromptMessage) {
            if (lastPromptId !== undefined && prompt.id === lastPromptId) {
              fail(`re-arm id ${prompt.id} reused for ${prompt.message}`);
            }
            lastPromptId = prompt.id;
            lastPromptMessage = prompt.message;
          }
        }
      }
    }

    let guard = 0;
    while (confirms.some((c) => c.settles === 0) && guard++ < 40) {
      const live = confirms.find((c) => c.settles === 0);
      ops.push(`drain-abort:${live?.id}`);
      live?.controller.abort();
      await flushMicro();
    }
    let closeGuard = 0;
    while (ui.kind() !== "none" && closeGuard++ < 12) {
      ops.push(`drain-close:${ui.kind()}`);
      if (ui.kind() === "confirm") ui.resolveConfirm(false);
      else ui.dismiss();
      await flushMicro();
    }
    for (const c of confirms) {
      if (c.settles !== 1) fail(`O1/O5 confirm ${c.id} settled ${c.settles} times at end`);
    }
    if (ui.kind() === "confirm") fail("O4 stale confirm at end");
    if (ui.kind() !== "none") fail(`O4 kind ${ui.kind()} left after drain`);
  } finally {
    ui.dispose();
  }
}

describe("overlay interleaving", () => {
  it("O1-O5 hold for every seeded overlay sequence", async () => {
    const only = process.env.PRAANA_OVERLAY_SEED;
    const seeds = only && Number.isInteger(Number(only)) && Number(only) > 0
      ? [Number(only)]
      : Array.from({ length: 300 }, (_, i) => i + 1);
    const failures: string[] = [];
    for (const seed of seeds) {
      try {
        await runOverlayInterleave(seed);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(message);
      }
    }
    expect(failures).toEqual([]);
  });
});
