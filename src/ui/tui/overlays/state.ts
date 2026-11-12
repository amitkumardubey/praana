/**
 * Reactive overlay state for in-session modals (Phase 3).
 */
import { createRoot, createSignal, type Accessor } from "solid-js";

export type OverlayKind =
  | "none"
  | "slash"
  | "model"
  | "login"
  | "logout"
  | "palette"
  | "setup"
  | "consent"
  | "confirm";

/**
 * `step` is the per-turn step pause (Enter continues, Esc stops). `yesno` asks
 * a risk question: y accepts, n / Enter / Esc decline.
 */
export type ConfirmMode = "step" | "yesno";

/** Minimal confirm prompt used by the per-turn step pause and risk confirmations. */
export interface ConfirmPromptState {
  message: string;
  mode: ConfirmMode;
  /**
   * Action preview rows rendered under the question (`edit_file`,
   * `git_commit`), already plain text. Empty for step and risk prompts.
   */
  preview: readonly string[];
  /** Changes for every confirm that is shown, so Enter's arm delay resets. */
  id: number;
}

export interface ShowConfirmOptions {
  /** Defaults to `step`. */
  mode?: ConfirmMode;
  /**
   * Plain-text rows rendered under the question. Carried separately from
   * `message` on purpose: a risk detail can contain blank lines, so a split
   * guessed from the text would truncate the command being approved.
   */
  preview?: readonly string[];
}

/**
 * Full-screen modal overlays that cover the screen and would let the idle
 * launch canvas bleed through. Palette / slash / model overlays sit on top
 * of the rest of the UI and must keep the canvas visible underneath.
 */
export const LAUNCH_HIDING_OVERLAYS: readonly OverlayKind[] = [
  "setup",
  "consent",
  "login",
];

/** True when the launch canvas should be hidden while `kind` is open. */
export function launchCanvasHiddenForOverlay(kind: OverlayKind): boolean {
  return kind !== "none" && LAUNCH_HIDING_OVERLAYS.includes(kind);
}

export interface OverlayUi {
  readonly kind: Accessor<OverlayKind>;
  readonly slashLines: Accessor<string[]>;
  readonly loginHint: Accessor<string | undefined>;
  readonly logoutHint: Accessor<string | undefined>;
  readonly confirmPrompt: Accessor<ConfirmPromptState | null>;
  showSlash(lines: string[]): void;
  showModel(): void;
  showLogin(providerHint?: string): void;
  showLogout(providerHint?: string): void;
  showPalette(): void;
  showSetup(): void;
  showConsent(): void;
  /**
   * Open a small confirm overlay; in `step` mode resolves true on Enter and
   * false on Esc, in `yesno` mode true on `y` and false on `n` / Enter / Esc.
   * `signal` aborting settles it false either way. Ctrl+C is not answered
   * here: it aborts the turn signal, which settles this promise false and
   * skips the wrap-up. If an interactive overlay or confirm is already open,
   * this waits until that one closes, then shows. A passive slash panel is
   * cleared instead. Aborting `signal` while waiting resolves false and drops
   * just this request.
   */
  showConfirm(message: string, signal?: AbortSignal, opts?: ShowConfirmOptions): Promise<boolean>;
  resolveConfirm(cont: boolean): void;
  dismiss(): void;
  dispose(): void;
}

export function createOverlayUi(): OverlayUi {
  return createRoot((dispose) => {
    const [kind, setKind] = createSignal<OverlayKind>("none");
    const [slashLines, setSlashLines] = createSignal<string[]>([]);
    const [loginHint, setLoginHint] = createSignal<string | undefined>(undefined);
    const [logoutHint, setLogoutHint] = createSignal<string | undefined>(undefined);
    const [confirmPrompt, setConfirmPrompt] = createSignal<ConfirmPromptState | null>(null);
    let confirmResolver: ((cont: boolean) => void) | null = null;
    let nextConfirmId = 0;
    // Confirms and overlays waiting to be shown. A confirm requested while
    // something else is open waits here and listens to its own signal.
    // Non-confirm requests queue behind an open confirm (a later one replaces
    // only a trailing overlay, never a confirm). dismiss() of an open confirm
    // settles only that confirm and promote() shows the queue. dispose() drops it.
    type QueuedConfirm = {
      type: "confirm";
      message: string;
      mode: ConfirmMode;
      preview: readonly string[];
      signal?: AbortSignal;
      resolve: (value: boolean) => void;
      onAbort: () => void;
      settled: boolean;
    };
    type QueuedOverlay = { type: "overlay"; open: () => void };
    const queue: Array<QueuedConfirm | QueuedOverlay> = [];

    // One gate for "this confirm settles exactly once", whether it is queued or visible.
    const settleOnce = (
      gate: { settled: boolean },
      signal: AbortSignal | undefined,
      onAbort: () => void,
      resolve: (value: boolean) => void,
      value: boolean,
    ): boolean => {
      if (gate.settled) return false;
      gate.settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
      return true;
    };

    const dropQueue = () => {
      const dropped = queue.splice(0);
      for (const entry of dropped) {
        if (entry.type === "confirm") settleOnce(entry, entry.signal, entry.onAbort, entry.resolve, false);
      }
    };

    const clearOverlayFields = () => {
      setSlashLines([]);
      setLoginHint(undefined);
      setLogoutHint(undefined);
    };

    const promote = () => {
      if (confirmResolver) return;
      while (queue.length > 0) {
        const next = queue[0]!;
        if (next.type === "overlay") {
          if (kind() !== "none" && kind() !== "confirm") return;
          queue.shift();
          setConfirmPrompt(null);
          next.open();
          return;
        }
        if (kind() !== "none" && kind() !== "confirm") return;
        queue.shift();
        next.signal?.removeEventListener("abort", next.onAbort);
        if (next.signal?.aborted) {
          settleOnce(next, next.signal, next.onAbort, next.resolve, false);
          continue;
        }
        openConfirm(next.message, next.mode, next.preview, next.signal, next.resolve, next);
        return;
      }
      if (kind() === "confirm") setKind("none");
    };

    const openConfirm = (
      message: string,
      mode: ConfirmMode,
      preview: readonly string[],
      signal: AbortSignal | undefined,
      resolve: (value: boolean) => void,
      entry?: QueuedConfirm,
    ) => {
      const gate = entry ?? { settled: false };
      let onAbort = () => {};
      const finish = (cont: boolean) => {
        if (!settleOnce(gate, signal, onAbort, resolve, cont)) return;
        confirmResolver = null;
        setConfirmPrompt(null);
        promote();
      };
      onAbort = () => finish(false);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      confirmResolver = finish;
      setConfirmPrompt({ message, mode, preview, id: ++nextConfirmId });
      setKind("confirm");
    };

    const enqueueConfirm = (
      message: string,
      mode: ConfirmMode,
      preview: readonly string[],
      signal?: AbortSignal,
    ): Promise<boolean> => {
      return new Promise((resolve) => {
        const entry: QueuedConfirm = {
          type: "confirm",
          message,
          mode,
          preview,
          signal,
          resolve,
          onAbort: () => {},
          settled: false,
        };
        entry.onAbort = () => {
          if (entry.settled) return;
          const idx = queue.indexOf(entry);
          if (idx >= 0) queue.splice(idx, 1);
          settleOnce(entry, entry.signal, entry.onAbort, entry.resolve, false);
        };
        if (signal) signal.addEventListener("abort", entry.onAbort, { once: true });
        queue.push(entry);
      });
    };

    const showConfirm = (
      message: string,
      signal?: AbortSignal,
      opts?: ShowConfirmOptions,
    ): Promise<boolean> => {
      if (signal?.aborted) return Promise.resolve(false);
      const mode = opts?.mode ?? "step";
      const preview = opts?.preview ?? [];
      // A slash panel closes on any key. Leave it up and the pause looks hung,
      // because the spinner is already stopped. Clear it and ask immediately.
      // Interactive overlays (palette, model, login, logout, setup, consent) still defer.
      if (kind() === "slash") {
        setSlashLines([]);
        setKind("none");
        // Work queued behind the panel stays queued. Opening through the
        // blocked path would promote that work and hide this confirm.
        return new Promise((resolve) => openConfirm(message, mode, preview, signal, resolve));
      }
      const blocked = confirmResolver !== null || kind() !== "none" || queue.length > 0;
      if (!blocked) {
        return new Promise((resolve) => openConfirm(message, mode, preview, signal, resolve));
      }
      const pending = enqueueConfirm(message, mode, preview, signal);
      if (!confirmResolver && kind() === "none") promote();
      return pending;
    };

    const enqueueOverlay = (open: () => void) => {
      // No visible confirm: open now. A confirm that is only queued stays queued.
      if (!confirmResolver) {
        open();
        return;
      }
      const last = queue[queue.length - 1];
      if (last?.type === "overlay") {
        queue[queue.length - 1] = { type: "overlay", open };
        return;
      }
      queue.push({ type: "overlay", open });
    };

    return {
      kind,
      slashLines,
      loginHint,
      logoutHint,
      confirmPrompt,
      showSlash(lines: string[]) {
        enqueueOverlay(() => {
          setSlashLines(lines);
          setKind("slash");
        });
      },
      showModel() {
        enqueueOverlay(() => setKind("model"));
      },
      showLogin(providerHint?: string) {
        enqueueOverlay(() => {
          setLoginHint(providerHint);
          setKind("login");
        });
      },
      showLogout(providerHint?: string) {
        enqueueOverlay(() => {
          setLogoutHint(providerHint);
          setKind("logout");
        });
      },
      showPalette() {
        enqueueOverlay(() => setKind("palette"));
      },
      showSetup() {
        enqueueOverlay(() => setKind("setup"));
      },
      showConsent() {
        enqueueOverlay(() => setKind("consent"));
      },
      showConfirm,
      resolveConfirm(cont: boolean) {
        confirmResolver?.(cont);
      },
      dismiss() {
        // Every overlay close path must go through dismiss() or promote().
        // A close that only clears kind leaves a queued confirm waiting, and its turn hangs.
        if (confirmResolver) {
          // finish() clears the prompt and promote() shows the queue.
          // setKind/setConfirmPrompt here would race that and are not needed.
          confirmResolver(false);
          return;
        }
        setKind("none");
        clearOverlayFields();
        promote();
      },
      dispose() {
        dropQueue();
        if (confirmResolver) confirmResolver(false);
        dispose();
      },
    };
  });
}
