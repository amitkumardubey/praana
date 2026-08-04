/**
 * Reactive overlay state for in-session modals (Phase 3).
 */
import { createRoot, createSignal, type Accessor } from "solid-js";

export type OverlayKind = "none" | "slash" | "model" | "login" | "logout";

export interface OverlayUi {
  readonly kind: Accessor<OverlayKind>;
  readonly slashLines: Accessor<string[]>;
  readonly loginHint: Accessor<string | undefined>;
  showSlash(lines: string[]): void;
  showModel(): void;
  showLogin(providerHint?: string): void;
  showLogout(): void;
  dismiss(): void;
  dispose(): void;
}

export function createOverlayUi(): OverlayUi {
  return createRoot((dispose) => {
    const [kind, setKind] = createSignal<OverlayKind>("none");
    const [slashLines, setSlashLines] = createSignal<string[]>([]);
    const [loginHint, setLoginHint] = createSignal<string | undefined>(undefined);

    return {
      kind,
      slashLines,
      loginHint,
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
      showLogout() {
        setKind("logout");
      },
      dismiss() {
        setKind("none");
        setSlashLines([]);
        setLoginHint(undefined);
      },
      dispose,
    };
  });
}
