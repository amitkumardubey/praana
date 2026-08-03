/**
 * Ephemeral toast overlay region (OpenTUI).
 *
 * Toasts appear above the input, auto-dismiss after their tone timeout, and
 * are never written to the scrollback transcript. Errors are sticky until the
 * next user interaction clears them.
 *
 * Design §8:
 *   info/success → 3s, warn → 5s, error → sticky (until clearErrors())
 */
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "./theme.js";

export type ToastTone = "info" | "success" | "warn" | "error";

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  expiresAt: number | null;
  node: TextRenderable;
}

const TOAST_DURATION: Record<ToastTone, number | null> = {
  info: 3000,
  success: 3000,
  warn: 5000,
  error: null,
};

const TONE_GLYPH: Record<ToastTone, string> = {
  info: "ℹ",
  success: "✓",
  warn: "▲",
  error: "✕",
};

export class ToastRegion extends BoxRenderable {
  private toasts: Toast[] = [];
  private nextId = 1;

  constructor(ctx: RenderContext) {
    super(ctx, { id: "toast-region", flexDirection: "column" });
  }

  show(message: string, tone: ToastTone = "info"): void {
    const duration = TOAST_DURATION[tone];
    const expiresAt = duration !== null ? Date.now() + duration : null;
    const id = this.nextId++;
    const color =
      tone === "error"
        ? TUI_STYLE.error
        : tone === "warn"
          ? TUI_STYLE.warning
          : tone === "success"
            ? TUI_STYLE.success
            : TUI_STYLE.info;
    const node = new TextRenderable(this.ctx, { content: color(`  ${TONE_GLYPH[tone]} ${message}`) });
    this.toasts.push({ id, message, tone, expiresAt, node });
    this.add(node);
    this.ctx.requestRender();
    if (expiresAt !== null) {
      setTimeout(() => this.dismiss(id), duration!);
    }
  }

  clearErrors(): void {
    this.toasts = this.toasts.filter((t) => {
      if (t.tone === "error") {
        this.remove(t.node);
        return false;
      }
      return true;
    });
    this.ctx.requestRender();
  }

  private dismiss(id: number): void {
    const toast = this.toasts.find((t) => t.id === id);
    if (!toast) return;
    this.remove(toast.node);
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.ctx.requestRender();
  }
}