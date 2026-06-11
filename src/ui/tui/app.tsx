import React, { useReducer, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
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

export interface TuiAppProps {
  controller: AppController;
  initialStatus: import("../../status-bar.js").StatusBarInput;
  recentLines: string[];
}

export function TuiApp({
  controller,
  initialStatus,
  recentLines,
}: TuiAppProps) {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [scrollOffset, setScrollOffset] = useState(0);
  const atBottomRef = useRef(true);
  const SCROLL_WINDOW = 30;

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

  /* ── Scrolling window ─────────────────────────────────────── */
  const totalCompleted = transcript.completed.length;
  const showScrolling = totalCompleted > SCROLL_WINDOW;

  const visibleEntries = useMemo(() => {
    if (!showScrolling) return transcript.completed;
    const end = Math.max(0, totalCompleted - scrollOffset);
    const start = Math.max(0, end - SCROLL_WINDOW);
    return transcript.completed.slice(start, end);
  }, [transcript.completed, scrollOffset, showScrolling, totalCompleted]);

  /* Auto-scroll: when new entries arrive and we're at the bottom, keep the view there */
  useEffect(() => {
    if (totalCompleted > 0 && atBottomRef.current) {
      setScrollOffset(0);
    }
  }, [totalCompleted]);

  const scrollUp = useCallback((amount: number) => {
    setScrollOffset((prev) => {
      const next = prev + amount;
      const maxOffset = Math.max(0, totalCompleted - SCROLL_WINDOW);
      const clamped = Math.min(next, maxOffset);
      atBottomRef.current = clamped === 0;
      return clamped;
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
      if (!trimmed || busyRef.current) return;

      if (trimmed.startsWith("/")) {
        const result = await controller.executeSlashCommand(trimmed);
        if (result.lines.length > 0) {
          dispatch({ type: "system_lines", lines: result.lines });
        }
        if (result.action === "refresh_status") refreshStatus();
        if (result.action === "exit") exit();
        return;
      }

      dispatch({ type: "user_message", text: trimmed });
      dispatch({ type: "set_busy", busy: true });

      try {
        await controller.runUserTurn(trimmed, sink);
        dispatch({ type: "assistant_complete" });
      } catch (err) {
        if (err instanceof TurnAbortedError) {
          dispatch({ type: "interrupted" });
        } else {
          dispatch({ type: "error", message: (err as Error).message });
          controller.session.eventLog.append({
            kind: "system_note",
            actor: "kernel",
            payload: { type: "error", message: (err as Error).message },
          });
        }
      } finally {
        dispatch({ type: "set_busy", busy: false });
        refreshStatus();
      }
    },
    [controller, sink, refreshStatus, exit]
  );

  useInput((_inputKey, key) => {
    /* Turn abort on Escape */
    if (transcript.busy && key.escape) {
      controller.abortTurn();
      return;
    }

    /* Scroll controls (only when there are enough entries) */
    if (!transcript.busy && showScrolling) {
      if (key.pageUp) {
        scrollUp(Math.floor(SCROLL_WINDOW * 0.4));
      } else if (key.pageDown) {
        scrollDown(Math.floor(SCROLL_WINDOW * 0.4));
      } else if (key.home) {
        scrollToTop();
      } else if (key.end) {
        scrollToBottom();
      }
    }
  });

  useEffect(() => {
    const onSigint = () => {
      controller.handleUserInterrupt(() => {
        dispatch({
          type: "system_lines",
          lines: ["Use /exit to save and quit."],
        });
      });
    };
    process.on("SIGINT", onSigint);
    return () => {
      process.removeListener("SIGINT", onSigint);
    };
  }, [controller]);

  const showLogo = totalCompleted <= bootLenRef.current;

  return (
    <Box flexDirection="column" height="100%" padding={1} gap={1}>
      {showLogo && <LogoBanner />}
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
        {visibleEntries.map((entry) => (
          <TranscriptLine key={entry.id} entry={entry} />
        ))}

        {/* Live entry and busy indicator follow the window */}
        {transcript.live && <TranscriptLine entry={transcript.live} />}
        {transcript.busy && !transcript.live && <BusyIndicator />}
      </Box>
      <StatusBarView status={status} />
      <Box padding={1} gap={1}>
        <Text color={PALETTE.assistant}>❯ </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={transcript.busy ? "running…" : "message or /command"}
        />
      </Box>
    </Box>
  );
}
