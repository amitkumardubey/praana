// ============================================================
// PRAANA — Rust v2 Phase 0 UI Contract fixture validator
//
// Static data validator for the authority-owned fixture inventory at
// crates/praana-core/tests/fixtures/ui_contract_v1/ (RUST_V2_UI_CONTRACT.md
// Section 13). It defines and imports no semantic Rust UI type.
// ============================================================

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Exact Section 13 inventory (repo-relative to the fixture root). */
const COMMAND_FILES = [
  "session_create",
  "session_resume_by_id",
  "session_resume_by_selector",
  "session_end",
  "session_snapshot",
  "session_clear",
  "session_new",
  "turn_submit",
  "turn_cancel",
  "risk_resolve",
  "slash_catalog",
  "slash_execute",
  "path_complete",
  "model_catalog",
  "model_select",
  "reasoning_set",
  "settings_patch",
  "transcript_page_tail",
  "transcript_page_before",
  "content_read_bytes",
  "content_read_lines",
  "content_read_grep",
  "setup_status",
  "setup_apply_redacted",
  "auth_login_api_key_redacted",
  "auth_login_device",
  "auth_logout",
  "consent_resolve",
  "runtime_ping",
  "shutdown",
];

const RESULT_FILES = [
  "session_create",
  "session_resume_by_id",
  "session_resume_by_selector",
  "session_end",
  "session_snapshot",
  "session_clear",
  "session_new",
  "turn_submit",
  "turn_cancel",
  "risk_resolve",
  "slash_catalog",
  "slash_execute",
  "path_complete",
  "model_catalog",
  "model_select",
  "reasoning_set",
  "settings_patch",
  "transcript_page_tail",
  "transcript_page_before",
  "content_read_bytes",
  "content_read_lines",
  "content_read_grep",
  "setup_status",
  "setup_apply_redacted",
  "auth_login_api_key_redacted",
  "auth_login_device",
  "auth_logout",
  "consent_resolve",
  "runtime_ping",
  "shutdown",
];

const EVENT_FILES = [
  "runtime_ready",
  "runtime_stopping",
  "runtime_stopped",
  "runtime_backpressure",
  "system_notice",
  "system_error",
  "session_opened",
  "session_status",
  "session_cleared",
  "session_ended",
  "model_changed",
  "reasoning_changed",
  "settings_changed",
  "context_updated",
  "turn_started",
  "attempt_started",
  "assistant_delta",
  "attempt_rewind",
  "assistant_accepted",
  "attempt_superseded",
  "usage_updated",
  "turn_completed",
  "turn_interrupted",
  "tool_batch_started",
  "tool_call_pending",
  "risk_confirmation_requested",
  "risk_confirmation_resolved",
  "tool_call_started",
  "tool_call_progress",
  "tool_call_finished",
  "tool_batch_finished",
  "setup_changed",
  "auth_flow_updated",
  "auth_changed",
  "consent_requested",
  "consent_resolved",
];

const EVENT_JSONL_FILES = [
  "previsible_retry",
  "postvisible_interruption",
  "cancel_rewind",
  "accepted_reconciliation",
  "memory_enabled",
];

const REJECTION_FILES = [
  "lowercase_ulid",
  "prefixed_operation_id",
  "recall_role",
  "settings_unknown_field",
  "operation_hash_conflict",
  "cursor_cross_session",
];

const EXPECTED_INVENTORY = [
  "manifest.json",
  "mapping.json",
  ...COMMAND_FILES.map((n) => `commands/${n}.json`),
  ...RESULT_FILES.map((n) => `results/${n}.json`),
  ...EVENT_FILES.map((n) => `events/${n}.json`),
  ...EVENT_JSONL_FILES.map((n) => `events/${n}.jsonl`),
  ...REJECTION_FILES.map((n) => `rejections/${n}.json`),
];

/** Exact Section 11 mapping rows in the owner's table order. */
const MAPPING_ROWS: Array<[string, string, string, string]> = [
  ["ui_to_core", "CoreCommand::SessionCreate", "session.create", "Effect::Invoke(CoreCommand::SessionCreate)"],
  ["ui_to_core", "CoreCommand::SessionResume", "session.resume", "Effect::Invoke(CoreCommand::SessionResume)"],
  ["ui_to_core", "CoreCommand::SessionEnd", "session.end", "Effect::Invoke(CoreCommand::SessionEnd)"],
  ["ui_to_core", "CoreCommand::SessionSnapshot", "session.snapshot", "Effect::Invoke(CoreCommand::SessionSnapshot)"],
  ["ui_to_core", "CoreCommand::SessionClear", "session.clear", "Effect::Invoke(CoreCommand::SessionClear)"],
  ["ui_to_core", "CoreCommand::SessionNew", "session.new", "Effect::Invoke(CoreCommand::SessionNew)"],
  ["ui_to_core", "CoreCommand::TurnSubmit", "turn.submit", "Effect::Invoke(CoreCommand::TurnSubmit)"],
  ["ui_to_core", "CoreCommand::TurnCancel", "turn.cancel", "Effect::Invoke(CoreCommand::TurnCancel)"],
  ["ui_to_core", "CoreCommand::RiskResolve", "risk.resolve", "Effect::Invoke(CoreCommand::RiskResolve)"],
  ["ui_to_core", "CoreCommand::SlashCatalog", "slash.catalog", "Effect::Invoke(CoreCommand::SlashCatalog)"],
  ["ui_to_core", "CoreCommand::SlashExecute", "slash.execute", "Effect::Invoke(CoreCommand::SlashExecute)"],
  ["ui_to_core", "CoreCommand::PathComplete", "path.complete", "Effect::Invoke(CoreCommand::PathComplete)"],
  ["ui_to_core", "CoreCommand::ModelCatalog", "catalog.models", "Effect::Invoke(CoreCommand::ModelCatalog)"],
  ["ui_to_core", "CoreCommand::ModelSelect", "model.select", "Effect::Invoke(CoreCommand::ModelSelect)"],
  ["ui_to_core", "CoreCommand::ReasoningSet", "reasoning.set", "Effect::Invoke(CoreCommand::ReasoningSet)"],
  ["ui_to_core", "CoreCommand::SettingsPatch", "settings.patch", "Effect::Invoke(CoreCommand::SettingsPatch)"],
  ["ui_to_core", "CoreCommand::TranscriptPage", "transcript.page", "Effect::Invoke(CoreCommand::TranscriptPage)"],
  ["ui_to_core", "CoreCommand::ContentRead", "content.read", "Effect::Invoke(CoreCommand::ContentRead)"],
  ["ui_to_core", "CoreCommand::SetupStatus", "setup.status", "Effect::Invoke(CoreCommand::SetupStatus)"],
  ["ui_to_core", "CoreCommand::SetupApply", "setup.apply", "Effect::Invoke(CoreCommand::SetupApply)"],
  ["ui_to_core", "CoreCommand::AuthLogin", "auth.login", "Effect::Invoke(CoreCommand::AuthLogin)"],
  ["ui_to_core", "CoreCommand::AuthLogout", "auth.logout", "Effect::Invoke(CoreCommand::AuthLogout)"],
  ["ui_to_core", "CoreCommand::ConsentResolve", "consent.resolve", "Effect::Invoke(CoreCommand::ConsentResolve)"],
  ["ui_to_core", "CoreCommand::RuntimePing", "runtime.ping", "Effect::Invoke(CoreCommand::RuntimePing)"],
  ["ui_to_core", "CoreCommand::Shutdown", "runtime.shutdown", "Effect::Invoke(CoreCommand::Shutdown)"],
  ["core_to_ui", "UiEvent::RuntimeReady", "runtime.ready", "Action::CoreEvent(UiEvent::RuntimeReady)"],
  ["core_to_ui", "UiEvent::RuntimeStopping", "runtime.stopping", "Action::CoreEvent(UiEvent::RuntimeStopping)"],
  ["core_to_ui", "UiEvent::RuntimeStopped", "runtime.stopped", "Action::CoreEvent(UiEvent::RuntimeStopped)"],
  ["core_to_ui", "UiEvent::RuntimeBackpressure", "runtime.backpressure", "Action::CoreEvent(UiEvent::RuntimeBackpressure)"],
  ["core_to_ui", "UiEvent::SystemNotice", "system.notice", "Action::CoreEvent(UiEvent::SystemNotice)"],
  ["core_to_ui", "UiEvent::SystemError", "system.error", "Action::CoreEvent(UiEvent::SystemError)"],
  ["core_to_ui", "UiEvent::SessionOpened", "session.opened", "Action::CoreEvent(UiEvent::SessionOpened)"],
  ["core_to_ui", "UiEvent::SessionStatus", "session.status", "Action::CoreEvent(UiEvent::SessionStatus)"],
  ["core_to_ui", "UiEvent::SessionCleared", "session.cleared", "Action::CoreEvent(UiEvent::SessionCleared)"],
  ["core_to_ui", "UiEvent::SessionEnded", "session.ended", "Action::CoreEvent(UiEvent::SessionEnded)"],
  ["core_to_ui", "UiEvent::ModelChanged", "model.changed", "Action::CoreEvent(UiEvent::ModelChanged)"],
  ["core_to_ui", "UiEvent::ReasoningChanged", "reasoning.changed", "Action::CoreEvent(UiEvent::ReasoningChanged)"],
  ["core_to_ui", "UiEvent::SettingsChanged", "settings.changed", "Action::CoreEvent(UiEvent::SettingsChanged)"],
  ["core_to_ui", "UiEvent::ContextUpdated", "context.updated", "Action::CoreEvent(UiEvent::ContextUpdated)"],
  ["core_to_ui", "UiEvent::TurnStarted", "turn.started", "Action::CoreEvent(UiEvent::TurnStarted)"],
  ["core_to_ui", "UiEvent::AttemptStarted", "attempt.started", "Action::CoreEvent(UiEvent::AttemptStarted)"],
  ["core_to_ui", "UiEvent::AssistantDelta", "assistant.delta", "Action::CoreEvent(UiEvent::AssistantDelta)"],
  ["core_to_ui", "UiEvent::AttemptRewind", "attempt.rewind", "Action::CoreEvent(UiEvent::AttemptRewind)"],
  ["core_to_ui", "UiEvent::AssistantAccepted", "assistant.accepted", "Action::CoreEvent(UiEvent::AssistantAccepted)"],
  ["core_to_ui", "UiEvent::AttemptSuperseded", "attempt.superseded", "Action::CoreEvent(UiEvent::AttemptSuperseded)"],
  ["core_to_ui", "UiEvent::UsageUpdated", "usage.updated", "Action::CoreEvent(UiEvent::UsageUpdated)"],
  ["core_to_ui", "UiEvent::TurnCompleted", "turn.completed", "Action::CoreEvent(UiEvent::TurnCompleted)"],
  ["core_to_ui", "UiEvent::TurnInterrupted", "turn.interrupted", "Action::CoreEvent(UiEvent::TurnInterrupted)"],
  ["core_to_ui", "UiEvent::ToolBatchStarted", "tool.batch_started", "Action::CoreEvent(UiEvent::ToolBatchStarted)"],
  ["core_to_ui", "UiEvent::ToolCallPending", "tool.call_pending", "Action::CoreEvent(UiEvent::ToolCallPending)"],
  ["core_to_ui", "UiEvent::RiskConfirmationRequested", "risk.confirmation_requested", "Action::CoreEvent(UiEvent::RiskConfirmationRequested)"],
  ["core_to_ui", "UiEvent::RiskConfirmationResolved", "risk.confirmation_resolved", "Action::CoreEvent(UiEvent::RiskConfirmationResolved)"],
  ["core_to_ui", "UiEvent::ToolCallStarted", "tool.call_started", "Action::CoreEvent(UiEvent::ToolCallStarted)"],
  ["core_to_ui", "UiEvent::ToolCallProgress", "tool.call_progress", "Action::CoreEvent(UiEvent::ToolCallProgress)"],
  ["core_to_ui", "UiEvent::ToolCallFinished", "tool.call_finished", "Action::CoreEvent(UiEvent::ToolCallFinished)"],
  ["core_to_ui", "UiEvent::ToolBatchFinished", "tool.batch_finished", "Action::CoreEvent(UiEvent::ToolBatchFinished)"],
  ["core_to_ui", "UiEvent::SetupChanged", "setup.changed", "Action::CoreEvent(UiEvent::SetupChanged)"],
  ["core_to_ui", "UiEvent::AuthFlowUpdated", "auth.flow_updated", "Action::CoreEvent(UiEvent::AuthFlowUpdated)"],
  ["core_to_ui", "UiEvent::AuthChanged", "auth.changed", "Action::CoreEvent(UiEvent::AuthChanged)"],
  ["core_to_ui", "UiEvent::ConsentRequested", "consent.requested", "Action::CoreEvent(UiEvent::ConsentRequested)"],
  ["core_to_ui", "UiEvent::ConsentResolved", "consent.resolved", "Action::CoreEvent(UiEvent::ConsentResolved)"],
];

const CROCKFORD_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const DOTTED_IPC_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const REPO_ROOT = join(import.meta.dir, "..");
const FIXTURE_ROOT = join(REPO_ROOT, "crates/praana-core/tests/fixtures/ui_contract_v1");

function fixtureRel(rel: string): string {
  return join(FIXTURE_ROOT, rel);
}

function requireFixture(rel: string): string {
  const abs = fixtureRel(rel);
  if (!existsSync(abs)) {
    throw new Error(`Missing UI contract fixture file: ui_contract_v1/${rel}`);
  }
  return readFileSync(abs, "utf8");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Recursively list files below the fixture root (fixture-relative POSIX keys). */
function listFixtureFiles(): string[] {
  if (!existsSync(FIXTURE_ROOT)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        out.push(relative(FIXTURE_ROOT, abs).split("\\").join("/"));
      }
    }
  };
  walk(FIXTURE_ROOT);
  return out.sort();
}

/** Walk a parsed JSON value; fail fast with a descriptive path prefix. */
function walkJson(value: unknown, visit: (v: unknown, key: string | null, path: string) => void, base = "$"): void {
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit, `${base}[]`);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      visit(v, k, `${base}.${k}`);
      walkJson(v, visit, `${base}.${k}`);
    }
  }
}

describe("rust-v2 UI contract fixture freeze", () => {
  it("inventory is exactly the authority's Section 13 list", () => {
    const present = new Set(listFixtureFiles());
    const missing = EXPECTED_INVENTORY.filter((rel) => !present.has(rel));
    const extra = [...present].filter((rel) => !EXPECTED_INVENTORY.includes(rel));
    expect(missing, `Missing UI contract fixtures: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `Unexpected extra UI contract fixture files: ${extra.join(", ")}`).toEqual([]);
  });

  it("manifest schema version, file lists, and digests are exact", () => {
    const manifest = JSON.parse(requireFixture("manifest.json")) as {
      ui_contract_schema_version: number;
      command_files: string[];
      result_files: string[];
      event_files: string[];
      rejection_files: string[];
      mapping_file: string;
      sha256_by_file: Record<string, string>;
    };

    expect(manifest.ui_contract_schema_version).toBe(1);
    expect(manifest.mapping_file).toBe("mapping.json");
    expect(manifest.command_files).toEqual(COMMAND_FILES.map((n) => `commands/${n}.json`));
    expect(manifest.result_files).toEqual(RESULT_FILES.map((n) => `results/${n}.json`));
    expect(manifest.event_files).toEqual([
      ...EVENT_FILES.map((n) => `events/${n}.json`),
      ...EVENT_JSONL_FILES.map((n) => `events/${n}.jsonl`),
    ]);
    expect(manifest.rejection_files).toEqual(REJECTION_FILES.map((n) => `rejections/${n}.json`));

    const diskFiles = listFixtureFiles().filter((rel) => rel !== "manifest.json");
    const keys = Object.keys(manifest.sha256_by_file);
    expect(keys).toEqual(diskFiles);
    for (const rel of keys) {
      const digest = manifest.sha256_by_file[rel];
      expect(SHA256_HEX.test(digest), `digest not 64-lowercase-hex: ${rel}`).toBe(true);
      expect(digest, `digest mismatch: ${rel}`).toBe(sha256Hex(readFileSync(fixtureRel(rel))));
    }
  });

  it("mapping.json carries every exact Section 11 row", () => {
    const mapping = JSON.parse(requireFixture("mapping.json")) as {
      ui_contract_schema_version: number;
      rows: Array<{
        direction: string;
        semantic_variant: string;
        ipc_dotted_name: string;
        ratatui_mapping: string;
      }>;
    };

    expect(mapping.ui_contract_schema_version).toBe(1);
    expect(mapping.rows).toEqual(
      MAPPING_ROWS.map(([direction, semanticVariant, ipcName, ratatuiMapping]) => ({
        direction,
        semantic_variant: semanticVariant,
        ipc_dotted_name: ipcName,
        ratatui_mapping: ratatuiMapping,
      })),
    );
    for (const row of mapping.rows) {
      expect(DOTTED_IPC_NAME.test(row.ipc_dotted_name)).toBe(true);
      expect(row.ipc_dotted_name.toLowerCase()).toBe(row.ipc_dotted_name);
    }
  });

  it("every ID is a complete uppercase Crockford ULID and every digest is complete", () => {
    // Only contract-owned ULID fields; model_id/provider_id/tool_name are
    // protocol strings, cursors are opaque, and resume_selector is 12 chars.
    const ULID_FIELDS = new Set([
      "operation_id", "session_id", "turn_id", "attempt_id", "step_id",
      "message_id", "event_id", "tool_batch_id", "tool_execution_id",
      "artifact_id", "state_id", "group_id", "entry_id", "block_id",
      "confirmation_id", "consent_id", "flow_id", "notice_id", "call_id",
      "user_message_id", "user_message_event_id", "canonical_event_id",
      "old_attempt_id", "replacement_attempt_id",
    ]);
    const ULID_ARRAY_FIELDS = new Set([
      "call_ids", "result_execution_ids", "discard_block_ids",
      "uncertain_execution_ids",
    ]);

    const validateParsed = (rel: string, parsed: unknown) => {
      walkJson(parsed, (value, key, path) => {
        if (typeof value !== "string" || key === null) return;
        if (ULID_FIELDS.has(key)) {
          expect(CROCKFORD_ULID.test(value), `bad ULID in ${rel}: ${path}`).toBe(true);
        }
        if (key === "resume_selector") {
          expect(value).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
        }
        if (key.endsWith("sha256") || key === "argument_sha256") {
          expect(SHA256_HEX.test(value), `bad digest in ${rel}: ${path}`).toBe(true);
        }
      });
      walkJson(parsed, (value, key) => {
        if (key === null || !ULID_ARRAY_FIELDS.has(key) || !Array.isArray(value)) return;
        for (const item of value) {
          expect(CROCKFORD_ULID.test(item as string), `bad ULID array item in ${rel}: ${key}`).toBe(true);
        }
      });
    };

    for (const rel of [...EXPECTED_INVENTORY]) {
      if (rel === "manifest.json" || rel === "mapping.json") continue;
      const raw = requireFixture(rel);
      if (rel.endsWith(".jsonl")) {
        expect(raw.includes("\r"), `${rel} contains CR`).toBe(false);
        expect(raw.endsWith("\n"), `${rel} must end with trailing LF`).toBe(true);
        for (const [index, line] of raw.slice(0, -1).split("\n").entries()) {
          validateParsed(`${rel}#${index}`, JSON.parse(line));
        }
        continue;
      }
      if (!rel.endsWith(".json")) continue;
      validateParsed(rel, JSON.parse(raw));
    }
  });

  it("no prefixed semantic IDs appear in canonical ID fields", () => {
    const scanPrefixedId = (parsed: unknown, label: string) => {
      walkJson(parsed, (value, key) => {
        if (typeof value !== "string" || key === null || !key.endsWith("_id")) return;
        expect(
          /^(op_|req_|conn_|stream_|block_|cursor_)/.test(value),
          `prefixed semantic ID in ${label}: ${value}`,
        ).toBe(false);
      });
    };

    for (const rel of EXPECTED_INVENTORY) {
      const raw = requireFixture(rel);
      if (rel.endsWith(".json")) {
        scanPrefixedId(JSON.parse(raw), rel);
      } else if (rel.endsWith(".jsonl")) {
        for (const [index, line] of raw.split("\n").filter(Boolean).entries()) {
          scanPrefixedId(JSON.parse(line), `${rel}#${index}`);
        }
      }
    }
  });

  it("auth and setup fixtures carry redacted sensitive values", () => {
    const authApiKey = JSON.parse(requireFixture("commands/auth_login_api_key_redacted.json"));
    walkJson(authApiKey, (value, key) => {
      if (key === "credential") expect(value).toBe("[REDACTED]");
    });

    const setupApply = JSON.parse(requireFixture("commands/setup_apply_redacted.json"));
    let sawSecret = false;
    walkJson(setupApply, (value, key) => {
      if (key === "type" && value === "secret") sawSecret = true;
      if (key === "value" && value === "[REDACTED]") sawSecret = true;
    });
    expect(sawSecret).toBe(true);
  });

  it("retry and reconciliation sequences match the owner's exact narratives", () => {
    const lines = (rel: string): string[] => {
      const raw = requireFixture(rel);
      expect(raw.includes("\r"), `${rel} contains CR`).toBe(false);
      expect(raw.endsWith("\n"), `${rel} must end with trailing LF`).toBe(true);
      return raw.slice(0, -1).split("\n").map((line) => JSON.parse(line));
    };
    const typesOf = (rows: Array<{ event: { type: string } }>) => rows.map((r) => r.event.type);

    expect(typesOf(lines("events/previsible_retry.jsonl"))).toEqual([
      "attempt_started",
      "attempt_rewind",
      "attempt_started",
      "assistant_accepted",
      "attempt_superseded",
    ]);

    expect(typesOf(lines("events/postvisible_interruption.jsonl"))).toEqual([
      "attempt_started",
      "assistant_delta",
      "attempt_rewind",
      "turn_interrupted",
    ]);

    expect(typesOf(lines("events/cancel_rewind.jsonl"))).toEqual([
      "attempt_started",
      "attempt_rewind",
      "turn_interrupted",
    ]);

    expect(typesOf(lines("events/accepted_reconciliation.jsonl"))).toEqual([
      "attempt_started",
      "assistant_accepted",
      "attempt_rewind",
    ]);
  });

  it("memory_enabled fixture gates memory entries on an enabled plugin", () => {
    const rows = requireFixture("events/memory_enabled.jsonl")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const opened = rows.find((r) => r.event.type === "session_opened");
    expect(opened).toBeDefined();
    expect(opened.event.data.boot.memory.state).toBe("available");
    expect(opened.event.data.metadata.incognito).toBe(false);

  });

  it("rejection fixtures carry typed targets and expected codes", () => {
    const expected = new Map([
      ["lowercase_ulid", { target: "command", expected_code: "invalid_ulid" }],
      ["prefixed_operation_id", { target: "command", expected_code: "invalid_ulid" }],
      ["recall_role", { target: "transcript", expected_code: "unknown_variant" }],
      ["settings_unknown_field", { target: "command", expected_code: "unknown_field" }],
      ["operation_hash_conflict", { target: "operation_replay", expected_code: "operation_conflict" }],
      ["cursor_cross_session", { target: "result", expected_code: "cursor_invalid" }],
    ]);
    for (const [name, meta] of expected) {
      const parsed = JSON.parse(requireFixture(`rejections/${name}.json`));
      expect(parsed.target).toBe((meta as { target: string }).target);
      expect(parsed.expected_code).toBe((meta as { expected_code: string }).expected_code);
      expect(typeof parsed.input_json).toBe("string");
 expect(parsed.input_json.length).toBeGreaterThan(0);
    }
  });

  it("fixtures contain no credentials, Recall role, or machine-specific values", () => {
    for (const rel of EXPECTED_INVENTORY) {
      const raw = requireFixture(rel);
      if (raw.includes("-----BEGIN")) {
        throw new Error(`${rel}: contains a PEM delimiter`);
      }
      if (/AKIA[A-Z0-9]{16}/.test(raw) || /sk-[A-Za-z0-9_-]{20,}/.test(raw)) {
        throw new Error(`${rel}: contains a credential-like value`);
      }
      if (raw.includes("/home/") || raw.includes("/Users/") || raw.includes("/tmp/")) {
        throw new Error(`${rel}: contains a machine-specific absolute path`);
      }
      if (rel.endsWith(".json") || rel.endsWith(".jsonl")) {
        if (/\bNaN\b/.test(raw) || /\bInfinity\b/.test(raw)) {
          throw new Error(`${rel}: contains a non-finite number`);
        }
      }
      const scanRecallRole = (parsed: unknown, label: string) => {
        walkJson(parsed, (value, key) => {
          if (key === "role" && value === "recall") {
            throw new Error(`${label}: contains a Recall role`);
          }
        });
      };
      if (rel.endsWith(".json")) {
        scanRecallRole(JSON.parse(raw), rel);
      } else if (rel.endsWith(".jsonl")) {
        for (const [index, line] of raw.split("\n").filter(Boolean).entries()) {
          scanRecallRole(JSON.parse(line), `${rel}#${index}`);
        }
      }
    }
  });
});
