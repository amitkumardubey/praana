/**
 * Download-consent overlay: SelectRenderable + keyInput Ctrl+C/Escape cancel.
 *
 * Uses createTestRenderer so we exercise OpenTUI focus/key routing without a real TTY.
 *
 * IMPORTANT: Do not run this file in the same bun process as tests/tui-run.test.ts —
 * that file mock.module-replaces @opentui/core globally.
 */
import { describe, it, expect } from "bun:test";
import {
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type KeyEvent,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

const DOWNLOAD_OPTIONS = [
  { value: "proceed", name: "Proceed", description: "Download and enable semantic search" },
  { value: "cancel", name: "Cancel", description: "Skip — keyword-only search still works" },
];

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Mirrors confirmModelDownload's interactive core against a test renderer.
 * Kept local so we can resolve without destroying a live createCliRenderer.
 */
async function runConsentInteraction(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
): Promise<{ promise: Promise<boolean>; select: SelectRenderable }> {
  const renderer = setup.renderer;
  const box = new BoxRenderable(renderer, {
    id: "download-consent",
    border: true,
    borderStyle: "rounded",
    padding: 1,
    flexDirection: "column",
    width: 60,
  });
  box.add(new TextRenderable(renderer, { content: "Download embedding model?" }));

  const select = new SelectRenderable(renderer, {
    id: "download-consent-select",
    height: 4,
    width: 50,
    options: DOWNLOAD_OPTIONS,
    showDescription: true,
  });
  box.add(select);
  renderer.root.add(box);
  select.focus();
  await setup.renderOnce();

  const promise = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      renderer.keyInput.off("keypress", onKeypress);
      resolve(result);
    };
    const onKeypress = (key: KeyEvent) => {
      if ((key.name === "c" && key.ctrl) || key.name === "escape") {
        finish(false);
      }
    };
    renderer.keyInput.on("keypress", onKeypress);
    select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
      finish(option.value === "proceed");
    });
  });

  return { promise, select };
}

describe("download consent interaction", () => {
  it("resolves true when Proceed is selected", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
      const { promise, select } = await runConsentInteraction(setup);
      select.setSelectedIndex(0);
      select.selectCurrent();
      await expect(withTimeout(promise, 2000, "proceed")).resolves.toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("resolves false when Cancel is selected", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
      const { promise, select } = await runConsentInteraction(setup);
      select.setSelectedIndex(1);
      select.selectCurrent();
      await expect(withTimeout(promise, 2000, "cancel")).resolves.toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("resolves false on Ctrl+C via keyInput", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
      const { promise } = await runConsentInteraction(setup);
      setup.mockInput.pressCtrlC();
      await expect(withTimeout(promise, 2000, "ctrl+c")).resolves.toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("resolves false on Escape via keyInput", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
      const { promise } = await runConsentInteraction(setup);
      setup.mockInput.pressEscape();
      await expect(withTimeout(promise, 2000, "escape")).resolves.toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("focuses the select so Enter selects without a parallel stdin listener", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
      const { select } = await runConsentInteraction(setup);
      expect(select.focused).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("confirmModelDownload non-TTY", () => {
  it("auto-proceeds when stderr is not a TTY", async () => {
    const { confirmModelDownload } = await import("../src/ui/tui/download-consent.js");
    const original = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    try {
      await expect(confirmModelDownload("Xenova/all-MiniLM-L6-v2")).resolves.toBe(true);
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: original, configurable: true });
    }
  });
});
