import React, { useReducer, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { PromptInput } from "./components/prompt-input.js";
import type { AppController } from "../../app-controller.js";
import { TurnAbortedError } from "../../turn-control.js";
import type { TranscriptEntry } from "./reducer.js";
import {
  createInitialTranscriptState,
  transcriptReducer,
} from "./reducer.js";
import { createTuiTurnSink } from "./sink.js";
import { PALETTE } from "./palette.js";
import { TranscriptLine } from "./transcript-line.js";
import { BusyIndicator } from "./busy-indicator.js";
import { LogoBanner } from "./logo-banner.js";
import { StatusBarView } from "./status-bar-view.js";
import { ToastLine, type ToastTone } from "./components/toast-line.js";

export interface TuiAppProps {
  controller: AppController;
  initialStatus: import("../../status-bar.js").StatusBarInput;
  recentLines: string[];
  transcriptBootstrap?: import("./reducer.js").TranscriptEntry[];
  bootSummary?: string;
  markdownRendering?: boolean;
  syntaxHighlighting?: boolean;
  syntaxTheme?: string;
}

export function TuiApp({
  controller,
  initialStatus,
  recentLines,
  transcriptBootstrap = [],
  bootSummary,
  markdownRendering = true,
  syntaxHighlighting = true,
  syntaxTheme = "nord",
}: TuiAppProps) {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);
  const [showBusy, setShowBusy] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  const atBottomRef = useRef(true);
  const SCROLL_WINDOW = 30;
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);

  const showToast = useCallback((message: string, tone: ToastTone = "info") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, tone });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 4000);
  }, []);

  const bootLenRef = useRef(0);

  const [transcript, dispatch] = useReducer(
    transcriptReducer,
    undefined,
    () => {
      const bootstrap: TranscriptEntry[] = [];
      let nextId = 1;
      const add = (role: TranscriptEntry["role"], text: string) => {
        bootstrap.push({ id: `boot-${nextId++}`, role, text, group: 0 });
      };
      if (recentLines.length > 0) {
        for (const line of recentLines) add("system", line);
      }
      if (transcriptBootstrap.length > 0) {
        return {
          ...createInitialTranscriptState(),
          completed: transcriptBootstrap,
          nextId: transcriptBootstrap.length + 1,
          groupCounter: transcriptBootstrap.reduce(
            (max, e) => Math.max(max, e.group),
            0
          ),
        };
      }
      bootLenRef.current = bootstrap.length;
      return {
        ...createInitialTranscriptState(),
        completed: bootstrap,
        nextId,
      };
    }
  );

  const sink = useMemo(() => createTuiTurnSink(dispatch), []);

  const refreshStatus = useCallback(() => {
    setStatus(controller.getStatusBarInput());
  }, [controller]);

  const showLogo =
    transcriptBootstrap.length === 0 && transcript.completed.length <= bootLenRef.current;

  /* ── Scrolling window (entry-based — preserves terminal scrollback) ── */
  const totalCompleted = transcript.completed.length;
  const showScrolling = totalCompleted > SCROLL_WINDOW;
  const visibleSlice = useMemo(() => {
    if (!showScrolling) {
      return { entries: transcript.completed, startIndex: 0 };
    }
    const end = Math.max(0, totalCompleted - scrollOffset);
    const start = Math.max(0, end - SCROLL_WINDOW);
    return { entries: transcript.completed.slice(start, end), startIndex: start };
  }, [transcript.completed, scrollOffset, showScrolling, totalCompleted]);
  const visibleEntries = visibleSlice.entries;
  const liveAssistantEmpty =
    transcript.live?.role === "assistant" && !transcript.live.text.trim();

  useEffect(() => {
    if (totalCompleted > 0 && atBottomRef.current) {
      setScrollOffset(0);
    }
  }, [totalCompleted]);

  useEffect(() => {
    if (!transcript.busy) {
      setShowBusy(false);
      return;
    }
    const waitingForOutput =
      !transcript.live ||
      (transcript.live.role === "assistant" && !transcript.live.text.trim());
    if (!waitingForOutput) {
      setShowBusy(false);
      return;
    }
    const t = setTimeout(() => setShowBusy(true), 450);
    return () => {
      clearTimeout(t);
      setShowBusy(false);
    };
  }, [transcript.busy, transcript.live]);

  const scrollUp = useCallback((amount: number) => {
    setScrollOffset((prev) => {
      const maxOffset = Math.max(0, totalCompleted - SCROLL_WINDOW);
      const next = Math.min(prev + amount, maxOffset);
      atBottomRef.current = next === 0;
      return next;
    });
  }, [totalCompleted]);

  const scrollDown = useCallback((amount: number) => {
    setScrollOffset((prev) => {
      const next = Math.max(0, prev - amount);
      atBottomRef.current = next === 0;
      return next;
    });
  }, []);

  const scrollToBottom = useCallback(() => {
    setScrollOffset(0);
    atBottomRef.current = true;
  }, []);

  const scrollToTop = useCallback(() => {
    const maxOffset = Math.max(0, totalCompleted - SCROLL_WINDOW);
    setScrollOffset(maxOffset);
    atBottomRef.current = false;
  }, [totalCompleted]);

  /* Busy ref avoids recreating handleSubmit on every transcript change */
  const busyRef = useRef(transcript.busy);
  busyRef.current = transcript.busy;

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      setInput("");
      if (!trimmed) return;
      if (busyRef.current) {
        showToast("Cannot process commands while a turn is active. Press Esc Esc to interrupt.", "error");
        return;
      }

      if (trimmed.startsWith("/")) {
        const result = await controller.executeSlashCommand(trimmed);
        if (result.lines.length > 0) {
          if (result.display === "toast") {
            showToast(result.lines.join(" "), result.toastTone ?? "info");
          } else {
            dispatch({ type: "system_lines", lines: result.lines });
          }
        }
        if (result.action === "refresh_status") refreshStatus();
        if (result.action === "exit") exit();
        return;
      }

      inputHistoryRef.current = [
        trimmed,
        ...inputHistoryRef.current.filter((h) => h !== trimmed),
      ].slice(0, 50);
      historyIndexRef.current = -1;

      dispatch({ type: "user_message", text: trimmed });
      dispatch({ type: "set_busy", busy: true });
      const turnStartedAt = Date.now();

      try {
        await controller.runUserTurn(trimmed, sink);
        sink.flushText?.();
        dispatch({ type: "assistant_complete" });
        const bar = controller.getStatusBarInput();
        dispatch({
          type: "turn_footer",
          model: bar.model,
          durationMs: Date.now() - turnStartedAt,
          stats: sink.consumeTurnStats?.() ?? undefined,
        });
      } catch (err) {
        if (err instanceof TurnAbortedError) {
          showToast("Turn interrupted");
          const bar = controller.getStatusBarInput();
          dispatch({
            type: "turn_footer",
            model: bar.model,
            durationMs: Date.now() - turnStartedAt,
            stats: sink.consumeTurnStats?.() ?? undefined,
          });
        } else {
          const message = (err as Error).message;
          controller.session.getLogger().error("Turn failed", {
            code: "TURN_FAILED",
            cause: err as Error,
          });
          dispatch({ type: "error", message });
        }
      } finally {
        dispatch({ type: "set_busy", busy: false });
        refreshStatus();
      }
    },
    [controller, sink, refreshStatus, exit, showToast]
  );

  const handleNavigationKey = useCallback(
    (key: import("ink").Key, input: string): boolean => {
      if (transcript.busy && key.escape) {
        controller.abortTurn();
        return true;
      }
      if (key.ctrl && input === "t" && !transcript.busy) {
        controller.showThinking = !controller.showThinking;
        refreshStatus();
        showToast(
          controller.showThinking ? "Thinking enabled." : "Thinking disabled."
        );
        return true;
      }
      return false;
    },
    [transcript.busy, controller, refreshStatus, showToast]
  );

  useInput((input, key) => {
    if (transcript.busy && key.escape) return;
    if (!showScrolling) return;
    if (key.pageUp) {
      scrollUp(Math.floor(SCROLL_WINDOW * 0.4));
    } else if (key.pageDown) {
      scrollDown(Math.floor(SCROLL_WINDOW * 0.4));
    } else if (input === "" && key.upArrow) {
      scrollUp(1);
    } else if (input === "" && key.downArrow) {
      scrollDown(1);
    } else if (key.home) {
      scrollToTop();
    } else if (key.end) {
      scrollToBottom();
    }
  });

  useEffect(() => {
    const onSigint = () => {
      controller.handleUserInterrupt(() => {
        showToast("Use /exit to save and quit.");
      });
    };
    process.on("SIGINT", onSigint);
    return () => {
      process.removeListener("SIGINT", onSigint);
    };
  }, [controller, showToast]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  return (
    <Box flexDirection="column" height="100%" padding={1} gap={1}>
      {showLogo && <LogoBanner bootSummary={bootSummary} />}
      <Box flexDirection="column" flexGrow={1}>
        {/* Scroll indicator when viewing older messages */}
        {showScrolling && scrollOffset > 0 && (
          <Box marginBottom={1}>
            <Text color={PALETTE.muted} dimColor>
              ↑ showing older messages (PgUp/PgDn to scroll, End for latest)
            </Text>
          </Box>
        )}
        {/* Visible transcript window */}
        {visibleEntries.map((entry, index) => (
          <TranscriptLine
            key={entry.id}
            entry={entry}
            prevRole={
              index > 0
                ? visibleEntries[index - 1]?.role
                : visibleSlice.startIndex > 0
                  ? transcript.completed[visibleSlice.startIndex - 1]?.role
                  : undefined
            }
            showThinking={status.thinking}
            markdownRendering={markdownRendering}
            syntaxHighlighting={syntaxHighlighting}
            syntaxTheme={syntaxTheme}
          />
        ))}

        {/* Live entry — placeholder keeps live non-null during tool transitions,
            so BusyIndicator only shows during the initial loading gap at turn start. */}
        {transcript.live ? (
          <>
            <TranscriptLine
              entry={transcript.live}
              prevRole={
                visibleEntries.length > 0
                  ? visibleEntries[visibleEntries.length - 1]?.role
                  : undefined
              }
              live
              showThinking={status.thinking}
              markdownRendering={markdownRendering}
              syntaxHighlighting={syntaxHighlighting}
              syntaxTheme={syntaxTheme}
            />
            {transcript.busy && liveAssistantEmpty && showBusy ? (
              <BusyIndicator />
            ) : null}
          </>
        ) : transcript.busy && showBusy ? (
          <BusyIndicator />
        ) : null}
      </Box>
      {toast ? <ToastLine message={toast.message} tone={toast.tone} /> : null}
      <Box paddingY={1} gap={1}>
        <Text color={PALETTE.assistant}>❯ </Text>
        <PromptInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={transcript.busy ? "running…" : "message or /command"}
          onNavigationKey={handleNavigationKey}
          onHistoryPrev={() => {
            const history = inputHistoryRef.current;
            if (history.length === 0) return null;
            const nextIndex = Math.min(
              historyIndexRef.current + 1,
              history.length - 1
            );
            historyIndexRef.current = nextIndex;
            return history[nextIndex] ?? null;
          }}
          onHistoryNext={() => {
            if (historyIndexRef.current <= 0) {
              historyIndexRef.current = -1;
              return "";
            }
            historyIndexRef.current -= 1;
            return inputHistoryRef.current[historyIndexRef.current] ?? "";
          }}
        />
      </Box>
      <StatusBarView status={status} />
    </Box>
  );
}
