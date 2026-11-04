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

/** Minimal confirm prompt used by the per-turn step pause. */
export interface ConfirmPromptState {
  message: string;
  /** Changes for every confirm that is shown, so Enter's arm delay resets. */
  id: number;
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
   * Open a small confirm overlay; resolves true on Enter, false on Esc/Ctrl+C
   * or when `signal` aborts. If another overlay or confirm is already open,
   * this waits until that one closes, then shows. Aborting `signal` while
   * waiting resolves false and drops just this request.
   */
  showConfirm(message: string, signal?: AbortSignal): Promise<boolean>;
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
    // only a trailing overlay, never a confirm). dismiss/dispose of an open
    // confirm drops the queue. Closing any other overlay promotes it.
    type QueuedConfirm = {
      type: "confirm";
      message: string;
      signal?: AbortSignal;
      resolve: (value: boolean) => void;
      onAbort: () => void;
      settled: boolean;
      opened: boolean;
    };
    type QueuedOverlay = { type: "overlay"; open: () => void };
    const queue: Array<QueuedConfirm | QueuedOverlay> = [];

    const settleQueued = (entry: QueuedConfirm, value: boolean) => {
      if (entry.settled) return;
      entry.settled = true;
      entry.signal?.removeEventListener("abort", entry.onAbort);
      entry.resolve(value);
    };

    const dropQueue = () => {
      const dropped = queue.splice(0);
      for (const entry of dropped) {
        if (entry.type === "confirm") settleQueued(entry, false);
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
        next.opened = true;
        next.signal?.removeEventListener("abort", next.onAbort);
        if (next.settled || next.signal?.aborted) {
          settleQueued(next, false);
          continue;
        }
        openConfirm(next.message, next.signal, next.resolve, next);
        return;
      }
      if (kind() === "confirm") setKind("none");
    };

    const openConfirm = (
      message: string,
      signal: AbortSignal | undefined,
      resolve: (value: boolean) => void,
      entry?: QueuedConfirm,
    ) => {
      if (signal?.aborted) {
        if (entry) settleQueued(entry, false);
        else resolve(false);
        promote();
        return;
      }
      let settled = false;
      const finish = (cont: boolean) => {
        if (settled) return;
        settled = true;
        if (entry) entry.settled = true;
        signal?.removeEventListener("abort", onAbort);
        confirmResolver = null;
        setConfirmPrompt(null);
        resolve(cont);
        promote();
      };
      const onAbort = () => finish(false);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      confirmResolver = finish;
      setConfirmPrompt({ message, id: ++nextConfirmId });
      setKind("confirm");
    };

    const enqueueConfirm = (message: string, signal?: AbortSignal): Promise<boolean> => {
      return new Promise((resolve) => {
        const entry: QueuedConfirm = {
          type: "confirm",
          message,
          signal,
          resolve,
          onAbort: () => {},
          settled: false,
          opened: false,
        };
        entry.onAbort = () => {
          if (entry.opened || entry.settled) return;
          const idx = queue.indexOf(entry);
          if (idx >= 0) queue.splice(idx, 1);
          settleQueued(entry, false);
        };
        if (signal) signal.addEventListener("abort", entry.onAbort, { once: true });
        queue.push(entry);
      });
    };

    const showConfirm = (message: string, signal?: AbortSignal): Promise<boolean> => {
      if (signal?.aborted) return Promise.resolve(false);
      const blocked = confirmResolver !== null || kind() !== "none" || queue.length > 0;
      if (!blocked) return new Promise((resolve) => openConfirm(message, signal, resolve));
      const pending = enqueueConfirm(message, signal);
      if (!confirmResolver && kind() === "none") promote();
      return pending;
    };

    const enqueueOverlay = (open: () => void) => {
      const confirmPending = confirmResolver !== null || queue.some((entry) => entry.type === "confirm");
      if (!confirmPending) {
        open();
        return;
      }
      // The confirm is waiting for the visible overlay to close. Replace that
      // overlay in place; do not answer the confirm.
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
        if (confirmResolver) {
          dropQueue();
          confirmResolver(false);
          setKind("none");
          setConfirmPrompt(null);
          clearOverlayFields();
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
