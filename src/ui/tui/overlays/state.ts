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
   * or when `signal` aborts. A confirm that is already open stays open: this
   * call waits and runs after it (see the priority rule on `createOverlayUi`).
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
    // Latest overlay requested while a step-pause confirm is open. Applied
    // when that confirm resolves or its signal aborts. It does not answer
    // the confirm. A newer request replaces the previous one; a replaced
    // queued confirm resolves false so its caller does not hang. dismiss
    // and dispose drop the queue.
    let deferredOverlay: (() => void) | null = null;
    let abandonDeferred: (() => void) | null = null;

    const queueOverlay = (open: () => void, abandon?: () => void) => {
      const previous = abandonDeferred;
      deferredOverlay = open;
      abandonDeferred = abandon ?? null;
      previous?.();
    };

    const takeDeferred = (): (() => void) | null => {
      const next = deferredOverlay;
      deferredOverlay = null;
      abandonDeferred = null;
      return next;
    };

    const dropDeferred = () => {
      const abandon = abandonDeferred;
      deferredOverlay = null;
      abandonDeferred = null;
      abandon?.();
    };

    const showConfirm = (message: string, signal?: AbortSignal): Promise<boolean> => {
      if (signal?.aborted) return Promise.resolve(false);
      if (confirmResolver) {
        return new Promise((resolve) => {
          queueOverlay(
            () => {
              void showConfirm(message, signal).then(resolve);
            },
            () => resolve(false),
          );
        });
      }
      return new Promise((resolve) => {
        let settled = false;
        const finish = (cont: boolean) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          confirmResolver = null;
          setConfirmPrompt(null);
          const next = takeDeferred();
          if (!next) setKind((current) => (current === "confirm" ? "none" : current));
          resolve(cont);
          next?.();
        };
        const onAbort = () => finish(false);
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        confirmResolver = finish;
        setConfirmPrompt({ message });
        setKind("confirm");
      });
    };

    const openUnlessPaused = (open: () => void) => {
      if (confirmResolver) queueOverlay(open);
      else open();
    };

    return {
      kind,
      slashLines,
      loginHint,
      logoutHint,
      confirmPrompt,
      showSlash(lines: string[]) {
        openUnlessPaused(() => {
          setSlashLines(lines);
          setKind("slash");
        });
      },
      showModel() {
        openUnlessPaused(() => setKind("model"));
      },
      showLogin(providerHint?: string) {
        openUnlessPaused(() => {
          setLoginHint(providerHint);
          setKind("login");
        });
      },
      showLogout(providerHint?: string) {
        openUnlessPaused(() => {
          setLogoutHint(providerHint);
          setKind("logout");
        });
      },
      showPalette() {
        openUnlessPaused(() => setKind("palette"));
      },
      showSetup() {
        openUnlessPaused(() => setKind("setup"));
      },
      showConsent() {
        openUnlessPaused(() => setKind("consent"));
      },
      showConfirm,
      resolveConfirm(cont: boolean) {
        confirmResolver?.(cont);
      },
      dismiss() {
        dropDeferred();
        if (confirmResolver) confirmResolver(false);
        setKind("none");
        setSlashLines([]);
        setLoginHint(undefined);
        setLogoutHint(undefined);
      },
      dispose() {
        dropDeferred();
        if (confirmResolver) confirmResolver(false);
        dispose();
      },
    };
  });
}
