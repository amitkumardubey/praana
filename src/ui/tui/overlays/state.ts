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
  resolve: (cont: boolean) => void;
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
  /** Open a small confirm overlay; resolves true on Enter, false on Esc/Ctrl+C. */
  showConfirm(message: string): Promise<boolean>;
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

    /** Resolve (and clear) a pending confirm prompt. No-op when none is open. */
    const flushConfirm = (cont: boolean) => {
      if (!confirmResolver) return;
      const resolve = confirmResolver;
      confirmResolver = null;
      setConfirmPrompt(null);
      resolve(cont);
    };

    return {
      kind,
      slashLines,
      loginHint,
      logoutHint,
      confirmPrompt,
      showSlash(lines: string[]) {
        flushConfirm(false);
        setSlashLines(lines);
        setKind("slash");
      },
      showModel() {
        flushConfirm(false);
        setKind("model");
      },
      showLogin(providerHint?: string) {
        flushConfirm(false);
        setLoginHint(providerHint);
        setKind("login");
      },
      showLogout(providerHint?: string) {
        flushConfirm(false);
        setLogoutHint(providerHint);
        setKind("logout");
      },
      showPalette() {
        flushConfirm(false);
        setKind("palette");
      },
      showSetup() {
        flushConfirm(false);
        setKind("setup");
      },
      showConsent() {
        flushConfirm(false);
        setKind("consent");
      },
      showConfirm(message: string) {
        // Replacing an open confirm is a transition away from it.
        flushConfirm(false);
        return new Promise<boolean>((resolve) => {
          confirmResolver = resolve;
          setConfirmPrompt({ message, resolve });
          setKind("confirm");
        });
      },
      resolveConfirm(cont: boolean) {
        flushConfirm(cont);
        setKind("none");
      },
      dismiss() {
        // Never leave a pending step-pause promise hanging — treat a dismiss
        // as a stop so the turn can proceed to its wrap-up.
        flushConfirm(false);
        setKind("none");
        setSlashLines([]);
        setLoginHint(undefined);
        setLogoutHint(undefined);
      },
      dispose() {
        flushConfirm(false);
        dispose();
      },
    };
  });
}
