/**
 * Reactive shell UI state shared between Solid components and the run.tsx bridge.
 *
 * Created once per session via createShellUi() and passed into <App />.
 */
import { createSignal, createRoot, type Accessor } from "solid-js";
import type { StatusBarInput } from "../../status-bar.js";
import type { ContextDisplaySnapshot } from "../../context-display.js";
import {
  formatTuiGlanceParts,
  formatTuiIdentityLine,
} from "./chrome/glance-format.js";
import { truncateSegments, TUI_STYLE, type TextSegment } from "./theme.js";

export type ToastTone = "info" | "success" | "warn" | "error";

export interface UiToast {
  id: number;
  message: string;
  tone: ToastTone;
}

/** Minimal console surface used for error/warn diagnostics (OpenTUI TerminalConsole). */
export interface DiagnosticConsole {
  show(): void;
}

export interface ToastApi {
  show(message: string, tone?: ToastTone): void;
  clearErrors(): void;
  /** Route error/warn through OpenTUI console instead of the toast strip. */
  attachConsole(console: DiagnosticConsole): void;
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
  readonly identitySegments: Accessor<TextSegment[]>;
  readonly glanceMetrics: Accessor<TextSegment[]>;
  readonly glanceFlags: Accessor<TextSegment[]>;
  /** Flat join of metrics + flags for legacy callers / tests. */
  readonly glanceSegments: Accessor<TextSegment[]>;
}

export interface LaunchApi {
  readonly version: Accessor<string>;
  readonly skillsLabel: Accessor<string>;
  setMeta(meta: { versionLabel: string; skillsLabel: string }): void;
}

export interface ShellUi {
  chrome: ChromeApi;
  launch: LaunchApi;
  toast: ToastApi;
  toasts: Accessor<UiToast[]>;
  spinner: SpinnerApi;
  dispose: () => void;
}

const TOAST_DURATION: Record<ToastTone, number> = {
  info: 3000,
  success: 3000,
  warn: 5000,
  error: 5000,
};

const SECTION_SEP: TextSegment = { text: " · ", style: TUI_STYLE.chromeMuted };

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
    const [identitySegments, setIdentitySegments] = createSignal<TextSegment[]>([
      { text: " praana", style: TUI_STYLE.chromeMuted },
    ]);
    const [glanceMetrics, setGlanceMetrics] = createSignal<TextSegment[]>([
      { text: " initializing…", style: TUI_STYLE.chromeMuted },
    ]);
    const [glanceFlags, setGlanceFlags] = createSignal<TextSegment[]>([]);
    const [launchVersion, setLaunchVersion] = createSignal("v0.0.0");
    const [launchSkills, setLaunchSkills] = createSignal("0 skills discovered");
    let backgroundZones = true;
    let lastStatus: StatusBarInput | null = null;
    let lastShowCost = false;
    let lastPreview: ContextDisplaySnapshot | null = null;
    let lastWidth = 80;
    let diagnosticConsole: DiagnosticConsole | null = null;

    const glanceSegments = (): TextSegment[] => {
      const m = glanceMetrics();
      const f = glanceFlags();
      if (f.length === 0) return m;
      if (m.length === 0) return f;
      return [...m, SECTION_SEP, ...f];
    };

    const repaintChrome = () => {
      const width = lastWidth;
      if (!lastStatus) {
        setIdentitySegments(
          truncateSegments([{ text: " praana", style: TUI_STYLE.chromeMuted }], width),
        );
        setGlanceMetrics(
          truncateSegments(
            [{ text: " initializing…", style: TUI_STYLE.chromeMuted }],
            width,
          ),
        );
        setGlanceFlags([]);
        return;
      }
      const status = lastPreview
        ? statusBarFromSnapshot(lastStatus, lastPreview)
        : lastStatus;
      const identity = formatTuiIdentityLine(status);
      const parts = formatTuiGlanceParts(status, { showCost: lastShowCost });

      // Budget: leave room for flags on the right (~24 cols) when wide enough.
      const flagBudget = Math.min(28, Math.max(12, Math.floor(width * 0.28)));
      const metricsBudget = Math.max(8, width - flagBudget - 2);

      setIdentitySegments(truncateSegments([{ text: " " }, ...identity], width));
      setGlanceMetrics(
        truncateSegments([{ text: " " }, ...parts.metrics], metricsBudget),
      );
      setGlanceFlags(truncateSegments(parts.flags, flagBudget));
    };

    const chrome: ChromeApi = {
      identitySegments,
      glanceMetrics,
      glanceFlags,
      glanceSegments,
      setBackgroundZones(enabled: boolean) {
        backgroundZones = enabled;
        void backgroundZones;
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
        void backgroundZones;
        repaintChrome();
      },
    };

    const launch: LaunchApi = {
      version: launchVersion,
      skillsLabel: launchSkills,
      setMeta(meta) {
        setLaunchVersion(meta.versionLabel);
        setLaunchSkills(meta.skillsLabel);
      },
    };

    const [toasts, setToasts] = createSignal<UiToast[]>([]);
    let nextToastId = 1;

    const toast: ToastApi = {
      attachConsole(consoleHost) {
        // Console stays available via ` toggle; we no longer auto-open it for
        // user-facing errors (those belong in the transcript).
        diagnosticConsole = consoleHost;
        void diagnosticConsole;
      },
      show(message: string, tone: ToastTone = "info") {
        const id = nextToastId++;
        setToasts((prev) => [...prev, { id, message, tone }]);
        const duration = TOAST_DURATION[tone];
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, duration);
      },
      clearErrors() {
        setToasts((prev) =>
          prev.filter((t) => t.tone !== "error" && t.tone !== "warn"),
        );
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

    return { chrome, launch, toast, toasts, spinner, dispose };
  });
}
