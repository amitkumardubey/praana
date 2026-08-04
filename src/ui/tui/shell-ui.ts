/**
 * Reactive shell UI state shared between Solid components and the run.tsx bridge.
 *
 * Created once per session via createShellUi() and passed into <App />.
 */
import { createSignal, createRoot, type Accessor } from "solid-js";
import type { StatusBarInput } from "../../status-bar.js";
import type { ContextDisplaySnapshot } from "../../context-display.js";
import { formatTuiGlanceLine, formatTuiIdentityLine } from "./chrome/glance-format.js";
import { paintZoneLine, truncatePlainText } from "./theme.js";
import chalk from "chalk";

export type ToastTone = "info" | "success" | "warn" | "error";

export interface UiToast {
  id: number;
  message: string;
  tone: ToastTone;
}

export interface ToastApi {
  show(message: string, tone?: ToastTone): void;
  clearErrors(): void;
}

export interface SpinnerApi {
  start(message: string): void;
  setMessage(message: string): void;
  stop(): void;
  readonly active: Accessor<boolean>;
  readonly message: Accessor<string>;
}

export interface ChromeApi {
  setStatus(input: StatusBarInput, opts: {
    showCost: boolean;
    backgroundZones: boolean;
    preview?: ContextDisplaySnapshot | null;
  }): void;
  setWidth(width: number): void;
  setBackgroundZones(enabled: boolean): void;
  readonly identityLine: Accessor<string>;
  readonly glanceLine: Accessor<string>;
}

export interface ShellUi {
  chrome: ChromeApi;
  toast: ToastApi;
  toasts: Accessor<UiToast[]>;
  spinner: SpinnerApi;
  dispose: () => void;
}

const TOAST_DURATION: Record<ToastTone, number | null> = {
  info: 3000,
  success: 3000,
  warn: 5000,
  error: null,
};

function statusBarFromSnapshot(
  base: StatusBarInput,
  snapshot: ContextDisplaySnapshot,
): StatusBarInput {
  return {
    ...base,
    contextUsedTokens: snapshot.usedTokens,
    contextWindowTokens: snapshot.windowTokens,
    contextDisplayMode: snapshot.mode,
    contextWeightedPct: snapshot.weightedPct,
    contextRawPct: snapshot.rawPct,
    contextPressureMode: snapshot.pressureMode,
  };
}

export function createShellUi(): ShellUi {
  return createRoot((dispose) => {
    const [identityLine, setIdentityLine] = createSignal(" praana");
    const [glanceLine, setGlanceLine] = createSignal(chalk.dim(" initializing…"));
    let backgroundZones = true;
    let lastStatus: StatusBarInput | null = null;
    let lastShowCost = false;
    let lastPreview: ContextDisplaySnapshot | null = null;
    let lastWidth = 80;

    const repaintChrome = () => {
      const width = lastWidth;
      if (!lastStatus) {
        setIdentityLine(
          paintZoneLine(truncatePlainText(" praana", width), "chrome", backgroundZones, width),
        );
        setGlanceLine(
          paintZoneLine(
            truncatePlainText(" " + chalk.dim("initializing…"), width),
            "chrome",
            backgroundZones,
            width,
          ),
        );
        return;
      }
      const status = lastPreview
        ? statusBarFromSnapshot(lastStatus, lastPreview)
        : lastStatus;
      const identity = formatTuiIdentityLine(status);
      const glance = formatTuiGlanceLine(status, { showCost: lastShowCost });
      setIdentityLine(
        paintZoneLine(truncatePlainText(" " + identity, width), "chrome", backgroundZones, width),
      );
      setGlanceLine(
        paintZoneLine(truncatePlainText(" " + glance, width), "chrome", backgroundZones, width),
      );
    };

    const chrome: ChromeApi = {
      identityLine,
      glanceLine,
      setBackgroundZones(enabled: boolean) {
        backgroundZones = enabled;
        repaintChrome();
      },
      setWidth(width: number) {
        if (width === lastWidth) return;
        lastWidth = Math.max(1, width);
        repaintChrome();
      },
      setStatus(input, opts) {
        lastStatus = input;
        lastShowCost = opts.showCost;
        lastPreview = opts.preview ?? null;
        backgroundZones = opts.backgroundZones;
        repaintChrome();
      },
    };

    const [toasts, setToasts] = createSignal<UiToast[]>([]);
    let nextToastId = 1;

    const toast: ToastApi = {
      show(message: string, tone: ToastTone = "info") {
        const id = nextToastId++;
        setToasts((prev) => [...prev, { id, message, tone }]);
        const duration = TOAST_DURATION[tone];
        if (duration !== null) {
          setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
          }, duration);
        }
      },
      clearErrors() {
        setToasts((prev) => prev.filter((t) => t.tone !== "error"));
      },
    };

    const [spinnerMessage, setSpinnerMessage] = createSignal("");
    const [spinnerActive, setSpinnerActive] = createSignal(false);

    const spinner: SpinnerApi = {
      active: spinnerActive,
      message: spinnerMessage,
      start(message: string) {
        setSpinnerMessage(message);
        setSpinnerActive(true);
      },
      setMessage(message: string) {
        setSpinnerMessage(message);
        if (!spinnerActive()) setSpinnerActive(true);
      },
      stop() {
        setSpinnerActive(false);
        setSpinnerMessage("");
      },
    };

    return { chrome, toast, toasts, spinner, dispose };
  });
}
