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
        setSlashLines(lines);
        setKind("slash");
      },
      showModel() {
        setKind("model");
      },
      showLogin(providerHint?: string) {
        setLoginHint(providerHint);
        setKind("login");
      },
      showLogout(providerHint?: string) {
        setLogoutHint(providerHint);
        setKind("logout");
      },
      showPalette() {
        setKind("palette");
      },
      showSetup() {
        setKind("setup");
      },
      showConsent() {
        setKind("consent");
      },
      showConfirm(message: string) {
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
