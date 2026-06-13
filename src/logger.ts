import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  APP_HOME_DIR,
  APP_NAME,
  resolveAppHomePath,
} from "./app-identity.js";
import pino, { type Logger as PinoLogger, type DestinationStream } from "pino";
import pretty from "pino-pretty";
import { Writable } from "node:stream";

export type LogLevel = "error" | "warn" | "info" | "debug";

export type LogDomain =
  | "app"
  | "compiler"
  | "llm"
  | "session"
  | "memory"
  | "config"
  | "tool"
  | "skills"
  | "context_engine";

export type ErrorCode =
  | "LLM_STREAM_ERROR"
  | "LLM_EMPTY_RESPONSE"
  | "LLM_ABORTED"
  | "TURN_FAILED"
  | "SESSION_START_FAILED"
  | "MEMORY_INIT_FAILED"
  | "TOOL_EXECUTION_FAILED"
  | "CONFIG_INVALID"
  | "UNKNOWN";

export interface LogEntry {
  level: LogLevel;
  domain: LogDomain;
  message: string;
  code?: ErrorCode;
  details?: Record<string, unknown>;
  cause?: Error;
}

export interface LoggerOptions {
  domain?: LogDomain;
  debug?: boolean;
  sessionId?: string;
  /** Base session directory from config (e.g. ~/.praana/sessions). */
  sessionLogDir?: string;
  /** Pre-built rolling file destination for ~/.praana/logs. */
  appFileStream?: DestinationStream;
  /** Pre-built rolling file destination for session system.log. */
  sessionFileStream?: DestinationStream;
  /** Test hook — capture formatted log lines instead of stderr/files. */
  writeLine?: (line: string) => void;
  /** TUI boot — capture notice lines instead of writing to stderr. */
  captureNotice?: (line: string) => void;
}

/** Daily rotated logs; symlink at `current.log` points to today's file. */
export const LOG_SYMLINK_FILENAME = "current.log";
export const LOG_RETENTION_DAYS = 15;
/** pino-roll retains `count` rotated files plus the active file. */
export const LOG_RETENTION_COUNT = LOG_RETENTION_DAYS - 1;

const PINO_LEVEL: Record<LogLevel, pino.Level> = {
  error: "error",
  warn: "warn",
  info: "info",
  debug: "debug",
};

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function getAppLogDir(): string {
  return resolveAppHomePath("logs");
}

/** Base path for pino-roll (extension added by rotator). */
export function getAppLogBase(): string {
  return join(getAppLogDir(), APP_NAME.toLowerCase());
}

/** Stable symlink path for tailing the active app log. */
export function getAppLogPath(): string {
  return join(getAppLogDir(), LOG_SYMLINK_FILENAME);
}

export function getSessionLogBase(sessionLogDir: string, sessionId: string): string {
  return join(expandHome(sessionLogDir), sessionId, "system");
}

/** Stable symlink path for tailing the active session system log. */
export function getSessionSystemLogPath(sessionLogDir: string, sessionId: string): string {
  return join(expandHome(sessionLogDir), sessionId, LOG_SYMLINK_FILENAME);
}

function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function isTestEnv(): boolean {
  return process.env.VITEST === "true";
}

const rollingStreams = new Map<string, DestinationStream>();

async function createRollingFileDestination(basePath: string): Promise<DestinationStream> {
  const cached = rollingStreams.get(basePath);
  if (cached) return cached;

  ensureParentDir(`${basePath}.log`);
  const pinoRoll = (await import("pino-roll")).default;
  const stream = await pinoRoll({
    file: basePath,
    frequency: "daily",
    dateFormat: "yyyy-MM-dd",
    mkdir: true,
    sync: true,
    symlink: true,
    limit: { count: LOG_RETENTION_COUNT, removeOtherLogFiles: true },
  });
  rollingStreams.set(basePath, stream);
  return stream;
}

function createStderrDestination(options: LoggerOptions): DestinationStream {
  if (options.writeLine) {
    return new Writable({
      write(chunk, _encoding, callback) {
        options.writeLine!(String(chunk).trimEnd());
        callback();
      },
    });
  }

  if (isTestEnv()) {
    return new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
  }

  if (process.stderr.isTTY) {
    return pretty({
      destination: 2,
      colorize: true,
      ignore: "pid,hostname,sessionId,domain,code,details,notice",
      messageFormat: (log, messageKey) => {
        const domain = typeof log.domain === "string" ? `[${log.domain}] ` : "";
        const code = typeof log.code === "string" ? `(${log.code}) ` : "";
        return `${domain}${code}${log[messageKey]}`;
      },
    });
  }

  return pino.destination({ dest: 2, sync: true });
}

function createPinoLogger(options: LoggerOptions): PinoLogger {
  const debug = options.debug ?? false;
  const stderrLevel = debug ? "debug" : "warn";
  const fileLevel = debug ? "debug" : "info";

  const streams: pino.StreamEntry[] = [
    { level: stderrLevel, stream: createStderrDestination(options) },
  ];

  if (!options.writeLine && !isTestEnv()) {
    if (options.appFileStream) {
      streams.push({ level: fileLevel, stream: options.appFileStream });
    }
    if (options.sessionFileStream) {
      streams.push({ level: fileLevel, stream: options.sessionFileStream });
    }
  }

  const destination =
    streams.length === 1 ? streams[0]!.stream : pino.multistream(streams);

  return pino(
    {
      level: debug ? "debug" : "info",
      base: options.sessionId ? { sessionId: options.sessionId } : undefined,
    },
    destination,
  );
}

export class PraanaLogger {
  private readonly pino: PinoLogger;
  private readonly options: Required<Pick<LoggerOptions, "domain" | "debug">> &
    Omit<LoggerOptions, "domain" | "debug">;

  constructor(options: LoggerOptions = {}) {
    this.options = {
      domain: options.domain ?? "app",
      debug: options.debug ?? false,
      sessionId: options.sessionId,
      sessionLogDir: options.sessionLogDir,
      appFileStream: options.appFileStream,
      sessionFileStream: options.sessionFileStream,
      writeLine: options.writeLine,
      captureNotice: options.captureNotice,
    };
    this.pino = createPinoLogger(this.options).child({ domain: this.options.domain });
  }

  child(domain: LogDomain): PraanaLogger {
    return new PraanaLogger({ ...this.options, domain });
  }

  log(entry: LogEntry): void {
    const fields: Record<string, unknown> = {
      ...(entry.code ? { code: entry.code } : {}),
      ...(entry.details ? { details: entry.details } : {}),
      ...(entry.cause ? { err: entry.cause } : {}),
    };
    const target =
      entry.domain && entry.domain !== this.options.domain
        ? this.pino.child({ domain: entry.domain })
        : this.pino;
    target[PINO_LEVEL[entry.level]](fields, entry.message);
  }

  error(
    message: string,
    opts?: {
      code?: ErrorCode;
      details?: Record<string, unknown>;
      cause?: Error;
      domain?: LogDomain;
    },
  ): void {
    this.log({
      level: "error",
      domain: opts?.domain ?? this.options.domain,
      message,
      code: opts?.code,
      details: opts?.details,
      cause: opts?.cause,
    });
  }

  warn(
    message: string,
    opts?: {
      code?: ErrorCode;
      details?: Record<string, unknown>;
      cause?: Error;
      domain?: LogDomain;
    },
  ): void {
    this.log({
      level: "warn",
      domain: opts?.domain ?? this.options.domain,
      message,
      code: opts?.code,
      details: opts?.details,
      cause: opts?.cause,
    });
  }

  info(message: string, opts?: { details?: Record<string, unknown>; domain?: LogDomain }): void {
    this.log({
      level: "info",
      domain: opts?.domain ?? this.options.domain,
      message,
      details: opts?.details,
    });
  }

  debug(message: string, opts?: { details?: Record<string, unknown>; domain?: LogDomain }): void {
    this.log({
      level: "debug",
      domain: opts?.domain ?? this.options.domain,
      message,
      details: opts?.details,
    });
  }

  /** User-visible status — always on stderr; also written to system log files at info level. */
  notice(message: string, opts?: { domain?: LogDomain; details?: Record<string, unknown> }): void {
    const domain = opts?.domain ?? this.options.domain;
    const line = `[${domain}] ${message}`;
    if (this.options.captureNotice) {
      this.options.captureNotice(line);
    } else if (this.options.writeLine) {
      this.options.writeLine(line);
    } else if (!isTestEnv()) {
      process.stderr.write(line + "\n");
    }
    const target =
      domain !== this.options.domain ? this.pino.child({ domain }) : this.pino;
    target.info(
      {
        ...(opts?.details ? { details: opts.details } : {}),
        notice: true,
      },
      message,
    );
  }
}

let appLogger = new PraanaLogger({ domain: "app" });
let appLogInitPromise: Promise<void> | null = null;

export function getAppLogger(): PraanaLogger {
  return appLogger;
}

export function setAppLogger(logger: PraanaLogger): void {
  appLogger = logger;
}

/** Initialise daily-rotating app log under ~/.praana/logs (no-op in tests). */
export async function initAppLogFile(): Promise<void> {
  if (isTestEnv()) return;
  if (appLogInitPromise) return appLogInitPromise;

  appLogInitPromise = (async () => {
    const stream = await createRollingFileDestination(getAppLogBase());
    appLogger = new PraanaLogger({ domain: "app", appFileStream: stream });
  })();

  return appLogInitPromise;
}

export async function createSessionLogger(opts: {
  sessionId: string;
  sessionLogDir: string;
  debug?: boolean;
  captureNotice?: (line: string) => void;
}): Promise<PraanaLogger> {
  if (isTestEnv()) {
    return new PraanaLogger({
      domain: "session",
      debug: opts.debug ?? false,
      sessionId: opts.sessionId,
      sessionLogDir: opts.sessionLogDir,
    });
  }

  await initAppLogFile();
  const appStream = rollingStreams.get(getAppLogBase());
  const sessionStream = await createRollingFileDestination(
    getSessionLogBase(opts.sessionLogDir, opts.sessionId),
  );

  return new PraanaLogger({
    domain: "session",
    debug: opts.debug ?? false,
    sessionId: opts.sessionId,
    sessionLogDir: opts.sessionLogDir,
    appFileStream: appStream,
    sessionFileStream: sessionStream,
    captureNotice: opts.captureNotice,
  });
}

export function createTestLogger(
  writeLine: (line: string) => void,
  opts?: { debug?: boolean },
): PraanaLogger {
  return new PraanaLogger({
    domain: "app",
    debug: opts?.debug ?? false,
    writeLine,
  });
}

/** Extract a human-readable message from a pi-ai assistant/error message object. */
export function extractLlmErrorMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;

  const msg = message as Record<string, unknown>;
  if (typeof msg.errorMessage === "string" && msg.errorMessage.trim()) {
    return msg.errorMessage.trim();
  }

  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        return b.text.trim();
      }
    }
  }

  return undefined;
}

export function formatUserFacingLlmError(opts: {
  reason: string;
  llmMessage?: string;
  model: string;
  provider: string;
}): string {
  const detail = opts.llmMessage?.trim();
  if (detail) {
    return `[LLM error: ${detail}]`;
  }
  if (opts.reason === "error") {
    return `[LLM request failed — see ~/.${APP_HOME_DIR}/logs/current.log or the session current.log (model: ${opts.model}, provider: ${opts.provider})]`;
  }
  return "[no response from model — try again or switch models with /model]";
}

export function isLogLevel(value: string): value is LogLevel {
  return value === "error" || value === "warn" || value === "info" || value === "debug";
}
