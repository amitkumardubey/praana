import type { Database } from "bun:sqlite";
import type { StateGraph } from "../state-graph.js";
import type { ContextEngineConfig } from "../types.js";
import { ActivityLog, deriveActivityEntries } from "./activity-log.js";
import {
  getExtractionState,
  insertActivityEntries,
  insertTurnDigest,
  listActivityEntries,
  upsertExtractionState,
} from "./db.js";
import { ErrorTracker } from "./error-tracker.js";
import { snapshotStateGraph } from "./state-snapshot.js";
import { extractTurnDigest } from "./turn-digest.js";
import type {
  ActivityEntry,
  CheckpointDraft,
  StateSnapshot,
  TurnDigest,
  TurnRecord,
} from "./types.js";

export class TurnExtraction {
  private readonly errorTracker: ErrorTracker;
  private readonly activityLog: ActivityLog;
  private recentDecisions: Array<{ summary: string; turn: number }> = [];
  private recentConstraints: string[] = [];
  private lastUserIntent = "";
  private lastDigest: TurnDigest | null = null;

  constructor(
    private readonly db: Database,
    private readonly sessionId: string,
    private readonly config: ContextEngineConfig,
  ) {
    const saved = getExtractionState(db, sessionId);
    this.errorTracker = new ErrorTracker({
      openErrors: saved?.openErrors,
      testFailed: saved?.testFailed,
    });
    this.activityLog = new ActivityLog(
      config.activity_log_max_entries,
      listActivityEntries(db, sessionId, config.activity_log_max_entries),
    );
    if (saved) {
      this.recentDecisions = saved.recentDecisions;
      this.recentConstraints = saved.recentConstraints;
      this.lastUserIntent = saved.lastUserIntent;
    }
  }

  captureStateSnapshot(stateGraph: StateGraph): StateSnapshot {
    return snapshotStateGraph(stateGraph);
  }

  processTurn(input: {
    userMessage: string;
    record: TurnRecord;
    stateBefore: StateSnapshot;
    stateGraph: StateGraph;
  }): TurnDigest {
    const turn = input.record.turn;
    const testWasFailing = this.errorTracker.isTestFailed();
    const { errorsNew, errorsFixed } = this.errorTracker.processTurn(turn, input.record);

    const digest = extractTurnDigest({
      turn,
      userMessage: input.userMessage,
      record: input.record,
      stateBefore: input.stateBefore,
      stateGraph: input.stateGraph,
      errorsNew,
      errorsFixed,
    });

    const activityEntries = deriveActivityEntries(
      turn,
      digest,
      input.record,
      testWasFailing,
    );

    this.lastDigest = digest;
    this.lastUserIntent = digest.userIntent;
    this.recentDecisions.push(
      ...digest.decisions.map((decision) => ({
        summary:
          typeof decision === "string" ? decision : decision.summary,
        turn,
      })),
    );
    this.recentConstraints.push(...digest.constraints);
    this.activityLog.append(activityEntries);

    insertTurnDigest(this.db, this.sessionId, digest);
    insertActivityEntries(this.db, this.sessionId, activityEntries);
    upsertExtractionState(this.db, this.sessionId, {
      openErrors: this.errorTracker.getOpenErrors(),
      testFailed: this.errorTracker.isTestFailed(),
      recentDecisions: this.recentDecisions.slice(-30),
      recentConstraints: this.recentConstraints.slice(-30),
      lastUserIntent: this.lastUserIntent,
    });

    return digest;
  }

  getLatestDigest(): TurnDigest | null {
    return this.lastDigest;
  }

  getRecentActivity(): ActivityEntry[] {
    return this.activityLog.list();
  }

  getCheckpointDraft(): CheckpointDraft {
    return {
      lastUserIntent: this.lastUserIntent,
      openErrors: this.errorTracker.getOpenErrors(),
      recentDecisions: [...this.recentDecisions],
      recentConstraints: [...this.recentConstraints],
      recentActivity: this.activityLog.list(),
    };
  }
}
