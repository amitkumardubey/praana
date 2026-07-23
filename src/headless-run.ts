/**
 * Headless one-shot execution: `praana run "<instruction>"`.
 *
 * Creates a session, runs a single turn (agent may call tools up to
 * `turn.max_steps`), streams assistant text to stdout, tools/status to
 * stderr, then shuts down. Intended for Harbor / Terminal-Bench / CI —
 * no TTY required.
 *
 * After the turn, writes a usage report (tokens + optional $) to
 * PRAANA_USAGE_PATH or ~/.praana/last-run-usage.json for Harbor AgentContext.
 */
import type { PraanaConfig } from "./types.js";
import { Session, type SessionEndStatus } from "./session.js";
import { runTurn } from "./turn.js";
import { printToolCall } from "./ui.js";
import type { TurnUiSink } from "./ui-events.js";
import {
  writeHeadlessUsageReport,
  type HeadlessUsageReport,
} from "./headless-usage.js";

export type HeadlessRunOptions = {
  cwd: string;
  config: PraanaConfig;
  prompt: string;
  /** Override `turn.max_steps` for this run only. */
  maxSteps?: number | null;
  debug?: boolean;
  incognito?: boolean;
  /** Override usage JSON path (else PRAANA_USAGE_PATH / default). */
  usagePath?: string | null;
  /** Injectable for tests. */
  createSession?: (
    cwd: string,
    config: PraanaConfig,
    opts?: { incognito?: boolean },
  ) => Promise<Session>;
  /** Injectable for tests. */
  runTurnFn?: typeof runTurn;
};

export type HeadlessRunResult = {
  sessionId: string;
  response: string;
  endStatus: SessionEndStatus;
  usage: HeadlessUsageReport | null;
};

/** Quiet sink: agent text → stdout; tools/errors → stderr; no banners/spinners. */
export function createHeadlessTurnSink(options?: {
  writeStdout?: (chunk: string) => void;
  writeStderr?: (chunk: string) => void;
}): TurnUiSink {
  const writeStdout = options?.writeStdout ?? ((c) => process.stdout.write(c));
  const writeStderr = options?.writeStderr ?? ((c) => process.stderr.write(c));

  return {
    // Buffer shell in memory so Harbor captures a clean agent transcript on stdout.
    shellLiveStream: false,
    onTextDelta: (delta) => writeStdout(delta),
    onThinkingDelta: undefined,
    onToolCallsStart: undefined,
    onToolCall: (_id, toolName, args) => printToolCall(toolName, args),
    onToolResult: undefined,
    onDebug: (message) => writeStderr(message.endsWith("\n") ? message : `${message}\n`),
    onDebugBlock: undefined,
    onMemoryBanner: undefined,
    onSpinnerStart: undefined,
    onSpinnerStop: undefined,
    onNewline: () => writeStdout("\n"),
    onFallback: (text) => writeStdout(text.endsWith("\n") ? text : `${text}\n`),
    onSystemLines: (lines) => {
      for (const line of lines) {
        writeStderr(line.endsWith("\n") ? line : `${line}\n`);
      }
    },
    onError: (entry) => {
      if (entry.level === "error" || entry.level === "warn") {
        writeStderr(`[${entry.domain}] ${entry.message}\n`);
      }
    },
  };
}

/** Apply a per-run max_steps override without mutating the caller's config object. */
export function withMaxSteps(
  config: PraanaConfig,
  maxSteps: number | null | undefined,
): PraanaConfig {
  if (maxSteps == null || !Number.isFinite(maxSteps) || maxSteps <= 0) {
    return config;
  }
  return {
    ...config,
    turn: {
      ...config.turn,
      max_steps: Math.floor(maxSteps),
    },
  };
}

export function validateRunPrompt(prompt: string | null | undefined): string {
  const trimmed = prompt?.trim() ?? "";
  if (!trimmed) {
    throw new Error(
      'Usage: praana run "<instruction>" [--max-steps N]\n' +
        "       praana run --prompt \"<instruction>\" [--max-steps N]",
    );
  }
  return trimmed;
}

function tryWriteUsage(
  session: Session,
  usagePath?: string | null,
): HeadlessUsageReport | null {
  try {
    return writeHeadlessUsageReport(session, usagePath);
  } catch (err) {
    process.stderr.write(
      `[headless] failed to write usage report: ${(err as Error).message}\n`,
    );
    return null;
  }
}

export async function runHeadless(
  opts: HeadlessRunOptions,
): Promise<HeadlessRunResult> {
  const prompt = validateRunPrompt(opts.prompt);
  const config = withMaxSteps(opts.config, opts.maxSteps);
  const createSession = opts.createSession ?? Session.create.bind(Session);
  const runTurnFn = opts.runTurnFn ?? runTurn;

  const session = await createSession(opts.cwd, config, {
    incognito: opts.incognito ?? false,
  });
  session.debug = opts.debug ?? false;
  session.headless = true;

  const sink = createHeadlessTurnSink();
  let usage: HeadlessUsageReport | null = null;

  try {
    const response = await runTurnFn(session, prompt, undefined, { sink });
    if (response && !response.endsWith("\n")) {
      process.stdout.write("\n");
    }
    usage = tryWriteUsage(session, opts.usagePath);
    const endStatus = await session.end("clean", session.getTranscriptEvents(), {
      memoryTimeoutMs: 50,
    });
    return {
      sessionId: session.id,
      response,
      endStatus,
      usage,
    };
  } catch (err) {
    usage = tryWriteUsage(session, opts.usagePath);
    try {
      await session.end("error", session.getTranscriptEvents(), {
        memoryTimeoutMs: 50,
      });
    } catch {
      // Shutdown best-effort; rethrow the original turn error.
    }
    throw err;
  }
}

export {
  buildHeadlessUsageReport,
  estimateCostUsd,
  lookupModelPrice,
  resolveUsageReportPath,
  writeHeadlessUsageReport,
} from "./headless-usage.js";
export type { HeadlessUsageReport } from "./headless-usage.js";
