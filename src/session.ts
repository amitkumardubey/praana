import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { ulid } from "ulid";
import type { CompileMetrics } from "./compiler.js";
import type { AriaConfig } from "./types.js";
import { EventLog, writeSessionMeta, readSessionMeta } from "./event-log.js";
import { StateGraph } from "./state-graph.js";
import { loadConfig } from "./config.js";
import {
  MemoryStore,
  createEmbedder,
  createSummarizer,
  type SessionEvent,
} from "./memory/index.js";

export class Session {
  id: string;
  cwd: string;
  config: AriaConfig;
  eventLog: EventLog;
  stateGraph: StateGraph;
  memoryStore: MemoryStore | null = null;
  memoryEnabled: boolean;
  incognito = false;
  digest: string | null = null;
  agentsContext: string | null = null;  // content from AGENTS.md / CLAUDE.md
  debug = false;
  private ended = false;
  private readonly startedAt: number;
  private turnCount = 0;
  private modelOverride: string | null = null;
  private lastCompileMetrics: CompileMetrics | null = null;

  private constructor(id: string, cwd: string, config: AriaConfig, startedAt: number) {
    this.id = id;
    this.cwd = cwd;
    this.config = config;
    this.startedAt = startedAt;

    const logDir = config.session.log_dir;
    this.eventLog = new EventLog(id, logDir);

    this.stateGraph = new StateGraph();
    this.memoryEnabled = config.memory.enabled;
  }

  static createNew(id: string, cwd: string, config: AriaConfig): Session {
    const startedAt = Date.now();
    const session = new Session(id, cwd, config, startedAt);

    writeSessionMeta(config.session.log_dir, {
      session_id: id,
      started_at: startedAt,
      cwd,
      agent: "aria",
    });

    return session;
  }

  static async create(
    cwd: string,
    config?: AriaConfig,
    opts?: { incognito?: boolean }
  ): Promise<Session> {
    const cfg = config ?? loadConfig();
    const id = ulid();
    const session = Session.createNew(id, cwd, cfg);
    session.incognito = opts?.incognito ?? false;
    session.agentsContext = loadAgentsContext(cwd);
    if (session.agentsContext) {
      const tokEst = Math.ceil(session.agentsContext.length / 4);
      console.log(`[context] Loaded project context (~${tokEst} tokens)`);
    }

    if (session.incognito) {
      session.memoryEnabled = false;
      session.memoryStore = null;
      session.digest = null;
      console.log("[incognito] Cross-session memory persistence disabled.");
      return session;
    }

    if (session.memoryEnabled) {
      try {
        session.memoryStore = await session.initMemoryStore();
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "session_start_begin",
          },
        });

        const d = await session.memoryStore.sessionStart({
          agent: "aria",
          user_id: hashString(process.env.USER ?? "unknown"),
          time: Date.now(),
          context_id: hashString(cwd),
          context_label: basename(cwd),
          working_context: { repo: { root: cwd, name: basename(cwd) } },
          recall_min_score: cfg.compiler.recall_min_score ?? 0.35,
        });

        session.digest = d.markdown;
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "session_start_success",
            digestLength: session.digest.length,
          },
        });
      } catch (err) {
        console.warn("[memory] Failed to initialize, continuing without:", (err as Error).message);
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "session_start_failure",
            error: (err as Error).message,
          },
        });
        session.memoryEnabled = false;
        session.memoryStore = null;
        session.digest = null;
      }
    }

    return session;
  }

  static async resume(
    sessionId: string,
    cwd: string,
    config?: AriaConfig
  ): Promise<Session> {
    const cfg = config ?? loadConfig();
    const meta = readSessionMeta(cfg.session.log_dir, sessionId);
    if (!meta) {
      throw new Error(`Session ${sessionId} not found.`);
    }

    const session = new Session(sessionId, cwd, cfg, meta.started_at);
    session.agentsContext = loadAgentsContext(cwd);
    if (session.agentsContext) {
      const tokEst = Math.ceil(session.agentsContext.length / 4);
      console.log(`[context] Loaded project context (~${tokEst} tokens)`);
    }

    // Replay context actions to rebuild state
    const actions = session.eventLog.replayContextActions();
    for (const ev of actions) {
      session.stateGraph.replayAction(ev.payload);
    }

    // Restore model override if one was set previously.
    const allEvents = session.eventLog.readAll();
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const ev = allEvents[i];
      if (ev.kind !== "system_note" || ev.payload.type !== "model_override") continue;
      const rawModel = ev.payload.model;
      if (typeof rawModel === "string" && rawModel.trim()) {
        session.modelOverride = rawModel.trim();
      } else {
        session.modelOverride = null;
      }
      break;
    }

    if (session.memoryEnabled) {
      try {
        session.memoryStore = await session.initMemoryStore();
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "resume_session_start_begin",
          },
        });

        // For resumed sessions, regenerate digest
        const d = await session.memoryStore.sessionStart({
          agent: "aria",
          user_id: hashString(process.env.USER ?? "unknown"),
          time: Date.now(),
          context_id: hashString(cwd),
          context_label: basename(cwd),
          working_context: { repo: { root: cwd, name: basename(cwd) } },
          recall_min_score: cfg.compiler.recall_min_score ?? 0.35,
        });

        session.digest = d.markdown;
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "resume_session_start_success",
            digestLength: session.digest.length,
          },
        });
      } catch (err) {
        console.warn("[memory] Failed to initialize for resumed session:", (err as Error).message);
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "resume_session_start_failure",
            error: (err as Error).message,
          },
        });
        session.memoryEnabled = false;
        session.memoryStore = null;
      }
    }

    return session;
  }

  incrementTurn(): void {
    this.turnCount++;
    this.stateGraph.incrementTurn();
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  getStartedAt(): number {
    return this.startedAt;
  }

  getUptimeMs(): number {
    return Math.max(0, Date.now() - this.startedAt);
  }

  setModelOverride(model: string | null): void {
    this.modelOverride = model && model.trim() ? model.trim() : null;
  }

  getModelOverride(): string | null {
    return this.modelOverride;
  }

  isIncognito(): boolean {
    return this.incognito;
  }

  async setIncognito(enabled: boolean): Promise<void> {
    this.incognito = enabled;
    if (enabled) {
      this.memoryEnabled = false;
      this.memoryStore = null;
      this.digest = null;
      return;
    }

    if (!this.config.memory.enabled) return;

    try {
      this.memoryStore = await this.initMemoryStore();
      const d = await this.memoryStore.sessionStart({
        agent: "aria",
        user_id: hashString(process.env.USER ?? "unknown"),
        time: Date.now(),
        context_id: hashString(this.cwd),
        context_label: basename(this.cwd),
        working_context: { repo: { root: this.cwd, name: basename(this.cwd) } },
        recall_min_score: this.config.compiler.recall_min_score ?? 0.35,
      });
      this.digest = d.markdown;
      this.memoryEnabled = true;
    } catch (err) {
      console.warn("[memory] Failed to re-enable memory:", (err as Error).message);
      this.memoryEnabled = false;
      this.memoryStore = null;
      this.digest = null;
    }
  }

  get promptDir(): string {
    return join(this.config.session.log_dir, this.id, "prompts");
  }

  getMemoryDbPath(): string | null {
    const configuredPath = this.config.memory?.db_path;
    if (configuredPath) {
      const p = expandHome(configuredPath);
      return p.startsWith("/") ? p : join(this.cwd, p);
    }
    return expandHome("~/.aria/memory.db");
  }

  getRepoRoot(): string {
    return findGitRoot(this.cwd);
  }

  setLastCompileMetrics(metrics: CompileMetrics): void {
    this.lastCompileMetrics = metrics;
  }

  getLastCompileMetrics(): CompileMetrics | null {
    return this.lastCompileMetrics;
  }

  getMemoryStats(): {
    total: number;
    active: number;
    soft: number;
    hard: number;
    byKind: Record<string, number>;
  } {
    const snapshot = this.stateGraph.snapshot();
    const byKind: Record<string, number> = {};
    let active = 0;
    let soft = 0;
    let hard = 0;

    for (const obj of snapshot) {
      byKind[obj.kind] = (byKind[obj.kind] ?? 0) + 1;
      if (obj.tier === "active") active++;
      else if (obj.tier === "soft") soft++;
      else hard++;
    }

    return { total: snapshot.length, active, soft, hard, byKind };
  }

  getPersistentMemoryEntryCount(): number | null {
    if (!this.memoryEnabled || !this.memoryStore) return null;
    return this.memoryStore.getEntryCount();
  }

  getSessionSummary(): {
    turns: number;
    stateObjects: number;
    memoriesStored: number;
  } {
    const events = this.eventLog.readAll();
    let turns = 0;
    let memoriesStored = 0;
    for (const ev of events) {
      if (ev.kind === "user_message") turns++;
      if (ev.kind !== "tool_result") continue;
      if (ev.payload.tool !== "remember") continue;
      const result = ev.payload.result as Record<string, unknown> | undefined;
      if (result?.ok === true) memoriesStored++;
    }
    return {
      turns,
      stateObjects: this.stateGraph.snapshot().length,
      memoriesStored,
    };
  }

  /** Build a transcript of user/agent/tool events for the summarizer. */
  getTranscriptEvents(): SessionEvent[] {
    const all = this.eventLog.readAll();
    const out: SessionEvent[] = [];
    for (const ev of all) {
      if (ev.kind === "user_message" || ev.kind === "agent_message") {
        out.push({ type: ev.kind, timestamp: ev.timestamp, content: (ev.payload.text as string) ?? "" });
      } else if (ev.kind === "tool_call") {
        out.push({ type: "tool_use", timestamp: ev.timestamp, tool_name: ev.payload.tool as string, args: ev.payload.args as Record<string, unknown> | undefined });
      } else if (ev.kind === "tool_result") {
        out.push({ type: "tool_result", timestamp: ev.timestamp, tool_name: ev.payload.tool as string, result: ev.payload.result });
      }
    }
    return out;
  }

  async end(
    reason: "clean" | "aborted" | "error",
    events?: SessionEvent[],
    opts?: { memoryTimeoutMs?: number }
  ): Promise<void> {
    if (this.ended) return;
    this.ended = true;

    if (this.memoryEnabled && this.memoryStore) {
      const memoryTimeoutMs = opts?.memoryTimeoutMs ?? 0;
      try {
        this.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "session_end_begin",
            reason,
          },
        });
        const finish = this.memoryStore.sessionEnd(reason, events);

        if (memoryTimeoutMs > 0) {
          const completed = await waitForCompletion(finish, memoryTimeoutMs);
          if (completed) {
            this.eventLog.append({
              kind: "system_note",
              actor: "kernel",
              payload: {
                type: "memory_lifecycle",
                phase: "session_end_success",
                reason,
              },
            });
          } else {
            // Ensure late failures are not unhandled after we stop waiting.
            void finish.catch((err: unknown) => {
              console.warn("[memory] Background session-end task failed:", (err as Error).message);
            });
            console.warn("[memory] Session-end summarization is continuing in background.");
            this.eventLog.append({
              kind: "system_note",
              actor: "kernel",
              payload: {
                type: "memory_lifecycle",
                phase: "session_end_background",
                reason,
                timeoutMs: memoryTimeoutMs,
              },
            });
          }
        } else {
          await finish;
          this.eventLog.append({
            kind: "system_note",
            actor: "kernel",
            payload: {
              type: "memory_lifecycle",
              phase: "session_end_success",
              reason,
            },
          });
        }
      } catch (err) {
        console.warn("[memory] Error during session end:", (err as Error).message);
        this.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "session_end_failure",
            reason,
            error: (err as Error).message,
          },
        });
      }
    }
    this.eventLog.close();
  }

  private async initMemoryStore(): Promise<MemoryStore> {
    const configuredPath = this.config.memory?.db_path;
    let dbPath: string;

    if (configuredPath) {
      dbPath = expandHome(configuredPath);
      if (!dbPath.startsWith("/")) dbPath = join(this.cwd, dbPath);
    } else {
      dbPath = expandHome("~/.aria/memory.db");
    }

    const embedder = await createEmbedder(this.config.memory);
    const summarizer = await createSummarizer(this.config.memory);

    return new MemoryStore({ dbPath, embedder, summarizer });
  }
}

// ---- Helpers ----

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? p.replace(/^~\//, `${homedir()}/`) : p;
}

async function waitForCompletion(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), timeoutMs);
  });
  const done = promise.then(() => true);
  return Promise.race([done, timeout]);
}

/** Find git root of the given directory, or return the directory itself. */
function findGitRoot(cwd: string): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

/**
 * Load project context from AGENTS.md / CLAUDE.md files.
 *
 * Load order (all non-empty results are merged):
 *   1. ~/.aria/AGENTS.md       — global personal instructions
 *   2. <git root>/AGENTS.md    — project-wide context
 *   3. <cwd>/AGENTS.md         — subdirectory context (if cwd ≠ git root)
 *   4. CLAUDE.md fallback      — if no AGENTS.md found at project root
 *
 * Combined content is capped at ~4000 tokens (16000 chars).
 */
export function loadAgentsContext(cwd: string): string | null {
  const MAX_CHARS = 16_000; // ~4000 tokens
  const parts: string[] = [];

  const tryRead = (filePath: string, label: string): void => {
    if (!existsSync(filePath)) return;
    try {
      const content = readFileSync(filePath, "utf-8").trim();
      if (content) parts.push(`<!-- ${label} -->\n${content}`);
    } catch { /* unreadable, skip */ }
  };

  // 1. Global personal instructions
  tryRead(expandHome("~/.aria/AGENTS.md"), "~/.aria/AGENTS.md");

  // 2. Project root AGENTS.md
  const gitRoot = findGitRoot(cwd);
  tryRead(join(gitRoot, "AGENTS.md"), "AGENTS.md");

  // 3. Subdirectory AGENTS.md (only if cwd differs from git root)
  if (cwd !== gitRoot) {
    tryRead(join(cwd, "AGENTS.md"), `${basename(cwd)}/AGENTS.md`);
  }

  // 4. CLAUDE.md fallback — only if no AGENTS.md was found at project root
  if (!existsSync(join(gitRoot, "AGENTS.md"))) {
    tryRead(join(gitRoot, "CLAUDE.md"), "CLAUDE.md");
    if (cwd !== gitRoot) {
      tryRead(join(cwd, "CLAUDE.md"), `${basename(cwd)}/CLAUDE.md`);
    }
  }

  if (parts.length === 0) return null;

  const combined = parts.join("\n\n");
  if (combined.length > MAX_CHARS) {
    console.warn(
      `[context] AGENTS.md content truncated to ~4000 tokens (was ${Math.ceil(combined.length / 4)} tokens)`
    );
    return combined.slice(0, MAX_CHARS) + "\n\n<!-- [truncated] -->";
  }
  return combined;
}
