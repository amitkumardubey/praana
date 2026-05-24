import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import {
  InProcessClient,
  StubEmbeddingsProvider,
  SqliteMemoryBackend,
  openDatabase,
  DisabledSummarizer,
  OllamaSummarizer,
  OpenAICompatibleSummarizer,
  EMBEDDING_DIM,
  type AgentKBClient,
} from "bodha";
import type { AriaConfig } from "./types.js";
import { EventLog, writeSessionMeta, readSessionMeta } from "./event-log.js";
import { StateGraph } from "./state-graph.js";
import { loadConfig } from "./config.js";

export class Session {
  id: string;
  cwd: string;
  config: AriaConfig;
  eventLog: EventLog;
  stateGraph: StateGraph;
  bodhaClient: AgentKBClient | null = null;
  bodhaEnabled: boolean;
  digest: string | null = null;
  private turnCount = 0;

  constructor(id: string, cwd: string, config: AriaConfig) {
    this.id = id;
    this.cwd = cwd;
    this.config = config;

    const logDir = config.session.log_dir;
    this.eventLog = new EventLog(id, logDir);

    writeSessionMeta(logDir, {
      session_id: id,
      started_at: Date.now(),
      cwd,
      agent: "aria",
    });

    this.stateGraph = new StateGraph();
    this.bodhaEnabled = config.bodha.enabled;
  }

  static async create(
    cwd: string,
    config?: AriaConfig
  ): Promise<Session> {
    const cfg = config ?? loadConfig();
    const id = ulid();
    const session = new Session(id, cwd, cfg);

    if (session.bodhaEnabled) {
      try {
        session.bodhaClient = session.initBodha();
        const digest = await session.bodhaClient.sessionStart({
          agent: "aria",
          user_id: hashString(process.env.USER ?? "unknown"),
          time: Date.now(),
          context_id: hashString(cwd),
          context_label: basename(cwd),
          working_context: {
            repo: {
              root: cwd,
              name: basename(cwd),
            },
          },
        });
        session.digest = digest.markdown;
      } catch (err) {
        console.warn("[bodha] Failed to initialize bodha, continuing without cross-session memory:", (err as Error).message);
        session.bodhaEnabled = false;
        session.bodhaClient = null;
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

    // Initialize bodha (no sessionStart for resumed — skip digest)
    if (session.bodhaEnabled) {
      try {
        session.bodhaClient = session.initBodha();
        // For resumed sessions, re-generate digest
        const digest = await session.bodhaClient.sessionStart({
          agent: "aria",
          user_id: hashString(process.env.USER ?? "unknown"),
          time: Date.now(),
          context_id: hashString(cwd),
          context_label: basename(cwd),
          working_context: {
            repo: {
              root: cwd,
              name: basename(cwd),
            },
          },
        });
        session.digest = digest.markdown;
      } catch (err) {
        console.warn("[bodha] Failed to initialize bodha for resumed session:", (err as Error).message);
        session.bodhaEnabled = false;
        session.bodhaClient = null;
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

  async end(reason: "clean" | "aborted" | "error"): Promise<void> {
    if (this.bodhaEnabled && this.bodhaClient) {
      try {
        await this.bodhaClient.sessionEnd(reason);
      } catch (err) {
        console.warn("[bodha] Error during session end:", (err as Error).message);
      }
    }
    this.eventLog.close();
  }

  private initBodha(): AgentKBClient {
    const db = openDatabase({
      path: expandHome("~/.bodha/kb.db"),
      readonly: false,
    });

    const backend = new SqliteMemoryBackend(db);
    const embeddings = new StubEmbeddingsProvider(EMBEDDING_DIM);

    // Choose summarizer
    const summarizerProvider = this.config.bodha.summarizer;
    let summarizer;
    if (summarizerProvider === "ollama") {
      summarizer = new OllamaSummarizer({
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen2.5:7b-instruct",
      });
    } else if (summarizerProvider === "openai") {
      summarizer = new OpenAICompatibleSummarizer({
        baseUrl: "https://api.openai.com/v1",
        apiKey: process.env.OPENAI_API_KEY ?? "",
        model: "gpt-4o-mini",
      });
    } else {
      summarizer = new DisabledSummarizer();
    }

    return new InProcessClient({
      backend,
      embeddings,
      summarizer,
      config: {
        digest: {
          token_budget: 1200,
          diversity_cap: 0.5,
          pinned_bonus: 0.1,
          sticky_floor_bonus: 0.2,
          adaptive_expansion: true,
          kind_weight_core_fact: 1.3,
          kind_weight_preference: 1.0,
          kind_weight_pattern: 1.0,
          kind_weight_context_fact: 1.0,
          kind_weight_decision: 1.0,
          kind_weight_mistake: 1.0,
        },
        confidence: {
          reinforcement_alpha: 0.15,
        },
      },
    });
  }
}

// ---- Helpers ----

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? p.replace(/^~\//, `${homedir()}/`) : p;
}
