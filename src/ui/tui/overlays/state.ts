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
  | "consent";

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
  showSlash(lines: string[]): void;
  showModel(): void;
  showLogin(providerHint?: string): void;
  showLogout(providerHint?: string): void;
  showPalette(): void;
  showSetup(): void;
  showConsent(): void;
  dismiss(): void;
  dispose(): void;
}

export function createOverlayUi(): OverlayUi {
  return createRoot((dispose) => {
    const [kind, setKind] = createSignal<OverlayKind>("none");
    const [slashLines, setSlashLines] = createSignal<string[]>([]);
    const [loginHint, setLoginHint] = createSignal<string | undefined>(undefined);
    const [logoutHint, setLogoutHint] = createSignal<string | undefined>(undefined);

    return {
      kind,
      slashLines,
      loginHint,
      logoutHint,
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
      dismiss() {
        setKind("none");
        setSlashLines([]);
        setLoginHint(undefined);
        setLogoutHint(undefined);
      },
      dispose,
    };
  });
}
