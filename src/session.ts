import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import type { AriaConfig } from "./types.js";
import { EventLog, writeSessionMeta, readSessionMeta } from "./event-log.js";
import { StateGraph } from "./state-graph.js";
import { loadConfig } from "./config.js";
import {
  MemoryStore,
  createEmbedder,
  OpenAISummarizer,
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
  digest: string | null = null;
  debug = false;
  private ended = false;
  private turnCount = 0;
  private modelOverride: string | null = null;

  private constructor(id: string, cwd: string, config: AriaConfig) {
    this.id = id;
    this.cwd = cwd;
    this.config = config;

    const logDir = config.session.log_dir;
    this.eventLog = new EventLog(id, logDir);

    this.stateGraph = new StateGraph();
    this.memoryEnabled = config.memory.enabled;
  }

  static createNew(id: string, cwd: string, config: AriaConfig): Session {
    const session = new Session(id, cwd, config);

    writeSessionMeta(config.session.log_dir, {
      session_id: id,
      started_at: Date.now(),
      cwd,
      agent: "aria",
    });

    return session;
  }

  static async create(
    cwd: string,
    config?: AriaConfig
  ): Promise<Session> {
    const cfg = config ?? loadConfig();
    const id = ulid();
    const session = Session.createNew(id, cwd, cfg);

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

    const session = new Session(sessionId, cwd, cfg);

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

  setModelOverride(model: string | null): void {
    this.modelOverride = model && model.trim() ? model.trim() : null;
  }

  getModelOverride(): string | null {
    return this.modelOverride;
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

  async end(reason: "clean" | "aborted" | "error", events?: SessionEvent[]): Promise<void> {
    if (this.ended) return;
    this.ended = true;

    if (this.memoryEnabled && this.memoryStore) {
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
        await this.memoryStore.sessionEnd(reason, events);
        this.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "session_end_success",
            reason,
          },
        });
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

    let summarizer = null;
    if (this.config.memory.summarizer !== "disabled") {
      const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
      const baseUrl = process.env.OPENROUTER_API_KEY
        ? "https://openrouter.ai/api/v1"
        : "https://api.openai.com/v1";
      const model =
        process.env.ARIA_SUMMARIZER_MODEL ??
        "google/gemini-2.5-flash";
      if (apiKey) {
        summarizer = new OpenAISummarizer({ baseUrl, apiKey, model });
      }
    }

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
