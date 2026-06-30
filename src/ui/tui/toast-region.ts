/**
 * Ephemeral toast overlay region.
 *
 * Toasts appear above the input, auto-dismiss after their tone timeout, and
 * are never written to the scrollback transcript. Errors are sticky until the
 * next user interaction clears them.
 *
 * Design §8:
 *   info/success → 3s, warn → 5s, error → sticky (until next user input)
 */
import type { Component } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { PALETTE } from "./theme.js";

export type ToastTone = "info" | "success" | "warn" | "error";

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  expiresAt: number | null; // null = sticky
}

const TOAST_DURATION: Record<ToastTone, number | null> = {
  info: 3000,
  success: 3000,
  warn: 5000,
  error: null, // sticky until clearErrors()
};

const TONE_GLYPH: Record<ToastTone, string> = {
  info: "ℹ",
  success: "✓",
  warn: "▲",
  error: "✕",
};

export class ToastRegion implements Component {
  private toasts: Toast[] = [];
  private nextId = 1;
  private readonly tui: TUI;

  constructor(tui: TUI) {
    this.tui = tui;
  }

  show(message: string, tone: ToastTone = "info"): void {
    const duration = TOAST_DURATION[tone];
    const expiresAt = duration !== null ? Date.now() + duration : null;
    const id = this.nextId++;
    this.toasts.push({ id, message, tone, expiresAt });
    this.tui.requestRender();
    if (expiresAt !== null) {
      setTimeout(() => { this.dismiss(id); }, duration!);
    }
  }

  clearErrors(): void {
    this.toasts = this.toasts.filter((t) => t.tone !== "error");
    this.tui.requestRender();
  }

  private dismiss(id: number): void {
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((t) => t.expiresAt === null || t.id !== id);
    if (this.toasts.length !== before) this.tui.requestRender();
  }

  invalidate(): void {
    // No cache; render() is pure.
  }

  render(_width: number): string[] {
    // Expire any timed-out toasts inline before render.
    const now = Date.now();
    this.toasts = this.toasts.filter((t) => t.expiresAt === null || t.expiresAt > now);

    return this.toasts.map((t) => {
      const glyph = TONE_GLYPH[t.tone];
      const color =
        t.tone === "error"
          ? chalk.hex(PALETTE.error)
          : t.tone === "warn"
            ? chalk.hex(PALETTE.warning)
            : t.tone === "success"
              ? chalk.hex(PALETTE.success)
              : chalk.hex(PALETTE.info);
      return `  ${color(glyph)} ${t.message}`;
    });
  }
}
