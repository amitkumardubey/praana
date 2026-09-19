//! P1C focused test: durable operation idempotency and crash recovery.
//!
//! Covers canonical request hashing with secret replacement, reservation
//! before effects, byte-for-byte duplicate replay, kind/hash conflicts,
//! dual-ledger duplicate detection, reserved-plan recovery at every crash
//! boundary (reservation, each planned event fsync, effect completion, result
//! persistence, host replacement, revision commit, journal cleanup),
//! retention, pragmas, corruption blocking, and secret exclusion.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use praana_core::history::operation_ledger::{
    get_effective_settings, get_host_revision, journal_cleanup, journal_commit_revision,
    journal_paths_for, journal_prepare, journal_replace_target, open_host_ledger,
    open_session_ledger, prune_host_terminal, recover_host_journal, recover_reserved_operations,
    reserve_operation, HistoryService, HostJournalStage, HostOperationJournalV1, HostStateTarget,
    LedgerScope, OperationLedger, RebuiltTerminal, RecoveryProbe, StoredOperation,
    HOST_PRUNE_AFTER_MS,
};
use praana_core::protocol::id::{EventId, SessionId, TurnId};
use praana_core::ui_contract::ids::OperationId;
use praana_core::ui_contract::json_data::Sha256Digest;
use praana_core::ui_contract::operation::{
    canonical_request_hash, error_result_hash, execute_core_command, operation_kind_for_command,
    sha256_hex_of, success_result_hash, CoreServices, OperationKind, OperationRecordDto,
    OperationReservation, PlannedEffectRef, StoredTerminalResult,
};
use praana_core::ui_contract::result::{
    CoreCommandResult, CoreCommandSuccess, CoreErrorCode, ErrorDetailsDto,
};
use praana_core::ui_contract::{CoreCommand, TurnSubmittedDto};

const FIXED_NOW_MS: i64 = 1_700_000_000_000;

fn test_history(session_id: SessionId) -> HistoryService {
    HistoryService {
        session_ledger: None,
        host_ledger: None,
        session_id: Some(session_id),
        probe: Arc::new(praana_core::history::operation_ledger::NullRecoveryProbe),
        now_ms: Arc::new(|| FIXED_NOW_MS),
    }
}

fn fixture_command(name: &str) -> CoreCommand {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ui_contract_v1/commands")
        .join(name);
    let bytes = std::fs::read(&path).expect("read command fixture");
    serde_json::from_slice(&bytes).expect("parse command fixture")
}

fn command_with_operation_id(mut command: CoreCommand, operation_id: OperationId) -> CoreCommand {
    let mut value = serde_json::to_value(&command).expect("serialize command");
    value
        .get_mut("data")
        .expect("command data")
        .as_object_mut()
        .expect("command object")
        .insert(
            "operation_id".to_string(),
            serde_json::Value::String(operation_id.to_string()),
        );
    command = serde_json::from_value(value).expect("reparse command");
    assert_eq!(command.operation_id(), Some(operation_id));
    command
}

fn open_session(dir: &Path, session_id: SessionId) -> OperationLedger {
    open_session_ledger(&dir.join("history.db"), session_id).expect("open session ledger")
}

fn open_host(dir: &Path) -> OperationLedger {
    open_host_ledger(&dir.join("ui-operations.db")).expect("open host ledger")
}

fn new_session_id() -> SessionId {
    SessionId(ulid::Ulid::generate())
}

fn new_operation_id() -> OperationId {
    OperationId(ulid::Ulid::generate())
}

struct FakeProbe {
    present: HashMap<(String, String), bool>,
    rebuild: Option<RebuiltTerminal>,
}

impl RecoveryProbe for FakeProbe {
    fn canonical_events_exist(&self, session_id: &SessionId, event_ids: &[EventId]) -> Vec<bool> {
        event_ids
            .iter()
            .map(|id| {
                *self
                    .present
                    .get(&(session_id.to_string(), id.to_string()))
                    .unwrap_or(&true)
            })
            .collect()
    }

    fn rebuild_terminal(&self, _record: &StoredOperation) -> Option<RebuiltTerminal> {
        self.rebuild.clone()
    }
}

fn turn_submitted_result(
    session_id: SessionId,
    turn_id: TurnId,
    event_id: EventId,
) -> CoreCommandSuccess {
    CoreCommandSuccess::TurnSubmitted(TurnSubmittedDto {
        session_id,
        turn_id,
        user_message_event_id: event_id,
        canonical_sequence: 43,
    })
}

#[test]
fn request_hashing_is_canonical_and_ignores_operation_id() {
    let first = command_with_operation_id(fixture_command("turn_submit.json"), new_operation_id());
    let second = command_with_operation_id(fixture_command("turn_submit.json"), new_operation_id());
    // Same payload with different operation IDs hashes identically: the hash
    // identifies the request, the operation ID identifies the operation.
    assert_eq!(
        canonical_request_hash(&first).unwrap(),
        canonical_request_hash(&second).unwrap()
    );
    let other_text = r#"{"type":"turn_submit","data":{"operation_id":"01J8Z3NDEK000000000000000K","text":"Different text.","client_submitted_at_ms":1700000001000}}"#;
    let other: CoreCommand = serde_json::from_str(other_text).unwrap();
    assert_ne!(
        canonical_request_hash(&first).unwrap(),
        canonical_request_hash(&other).unwrap()
    );
    // Read-only commands have no request hash.
    let ping = fixture_command("runtime_ping.json");
    assert!(operation_kind_for_command(&ping).is_none());
    assert!(canonical_request_hash(&ping).is_err());
}

#[test]
fn secret_values_are_replaced_before_hashing() {
    let secret_a = "sk-live-secret-alpha";
    let secret_b = "sk-live-secret-beta";
    let apply_a = setup_apply_with_secret(secret_a);
    let apply_a_again = setup_apply_with_secret(secret_a);
    let apply_b = setup_apply_with_secret(secret_b);
    // Same secret hashes identically; different secrets hash differently.
    assert_eq!(
        canonical_request_hash(&apply_a).unwrap(),
        canonical_request_hash(&apply_a_again).unwrap()
    );
    assert_ne!(
        canonical_request_hash(&apply_a).unwrap(),
        canonical_request_hash(&apply_b).unwrap()
    );
    // The hash digest reveals nothing on its own.
    let hash = canonical_request_hash(&apply_a).unwrap();
    assert_eq!(hash.as_str().len(), 64);
}

fn setup_apply_with_secret(secret: &str) -> CoreCommand {
    use praana_core::ui_contract::setup::{SetupFieldId, SetupValueDto};
    let mut values = std::collections::BTreeMap::new();
    values.insert(
        SetupFieldId("api_key".to_string()),
        SetupValueDto::Secret(secret.to_string().into()),
    );
    let command = praana_core::ui_contract::command::SetupApplyCommand {
        operation_id: new_operation_id(),
        expected_revision: 2,
        provider: "openai".parse().unwrap(),
        model_id: "gpt-5".parse().unwrap(),
        values,
    };
    CoreCommand::SetupApply(command)
}

#[test]
fn operation_dto_kinds_cover_mutating_commands() {
    assert_eq!(
        operation_kind_for_command(&fixture_command("turn_submit.json")),
        Some(OperationKind::TurnSubmit)
    );
    assert_eq!(
        operation_kind_for_command(&fixture_command("settings_patch.json")),
        Some(OperationKind::SettingsPatch)
    );
    assert_eq!(
        operation_kind_for_command(&fixture_command("shutdown.json")),
        Some(OperationKind::Shutdown)
    );
    // Read-only commands require no operation ID.
    for name in [
        "session_snapshot.json",
        "slash_catalog.json",
        "path_complete.json",
        "model_catalog.json",
        "transcript_page_tail.json",
        "content_read_bytes.json",
        "setup_status.json",
        "runtime_ping.json",
    ] {
        let command = fixture_command(name);
        assert!(operation_kind_for_command(&command).is_none(), "{name}");
        assert!(command.operation_id().is_none(), "{name}");
    }
}

#[test]
fn result_hashes_cover_success_and_terminal_error() {
    let session_id = new_session_id();
    let success = turn_submitted_result(
        session_id,
        TurnId(ulid::Ulid::generate()),
        EventId(ulid::Ulid::generate()),
    );
    let hash = success_result_hash(&success).unwrap();
    assert_eq!(hash.as_str().len(), 64);
    let error = praana_core::ui_contract::result::CoreErrorDto {
        code: CoreErrorCode::Unavailable,
        message: "x".to_string(),
        retry: praana_core::ui_contract::result::ErrorRetryAdvice::NewOperation,
        details: praana_core::ui_contract::result::ErrorDetailsDto::None,
    };
    let error_hash = error_result_hash(&error).unwrap();
    assert_ne!(hash, error_hash);
}

#[tokio::test]
async fn terminal_results_replay_byte_for_byte_without_another_effect() {
    let dir = tempfile::tempdir().unwrap();
    let session_id = new_session_id();
    let session_ledger = Arc::new(open_session(dir.path(), session_id));
    let host_ledger = Arc::new(open_host(dir.path()));
    let history = HistoryService {
        session_ledger: Some(session_ledger.clone()),
        host_ledger: Some(host_ledger.clone()),
        session_id: Some(session_id),
        probe: Arc::new(praana_core::history::operation_ledger::NullRecoveryProbe),
        now_ms: Arc::new(|| FIXED_NOW_MS),
    };
    let core = CoreServices {
        ledger: session_ledger.clone(),
        history,
        session_id: Some(session_id),
        turn_active: false,
    };
    let command =
        command_with_operation_id(fixture_command("turn_submit.json"), new_operation_id());
    // No effect subsystem belongs to P1C: the honest terminal error persists
    // before the first return.
    let first = execute_core_command(&core, command_value(&command)).await;
    let second = execute_core_command(&core, command_value(&command)).await;
    let to_bytes = |result: &CoreCommandResult| {
        praana_core::canonical_json::to_canonical_json_bytes(result).unwrap()
    };
    assert_eq!(to_bytes(&first), to_bytes(&second));
    match &first {
        CoreCommandResult::Err(error) => assert_eq!(error.code, CoreErrorCode::Unavailable),
        _ => panic!("expected honest unavailable terminal"),
    }
    // Exactly one terminal row exists for the operation.
    let stored = session_ledger
        .lookup(&command.operation_id().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        stored.dto.status,
        praana_core::ui_contract::operation::OperationStatus::Failed
    );
    assert!(stored.result_json.is_some());
}

fn command_value(command: &CoreCommand) -> CoreCommand {
    let bytes = serde_json::to_vec(command).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn mismatched_kind_or_hash_returns_conflict_without_effect() {
    let dir = tempfile::tempdir().unwrap();
    let session_id = new_session_id();
    let ledger = open_session(dir.path(), session_id);
    let history = test_history(session_id);
    let operation_id = new_operation_id();
    let first = command_with_operation_id(fixture_command("turn_submit.json"), operation_id);
    let reservation = reserve_operation(&ledger, &first, &history).await.unwrap();
    assert!(matches!(reservation, OperationReservation::Reserved(_)));
    // Same ID with a different request hash conflicts and performs no effect.
    let different = command_with_operation_id(
        serde_json::from_str::<CoreCommand>(
            r#"{"type":"turn_submit","data":{"operation_id":"01J8Z3NDEK000000000000000K","text":"Changed text.","client_submitted_at_ms":1700000001000}}"#,
        )
        .unwrap(),
        operation_id,
    );
    let conflict = reserve_operation(&ledger, &different, &history)
        .await
        .expect_err("hash mismatch conflicts");
    assert_eq!(conflict.code, CoreErrorCode::OperationConflict);
    match &conflict.details {
        ErrorDetailsDto::OperationConflict {
            existing_request_sha256,
        } => assert_eq!(existing_request_sha256.as_str().len(), 64),
        _ => panic!("conflict must carry the existing request hash only"),
    }
}

#[tokio::test]
async fn operation_id_in_both_ledgers_is_an_integrity_error() {
    let dir = tempfile::tempdir().unwrap();
    let session_id = new_session_id();
    let session_ledger = open_session(dir.path(), session_id);
    let host_ledger = open_host(dir.path());
    let operation_id = new_operation_id();
    // Reserve the same ID in each ledger without cross-links (simulating two
    // independent writers), then observe detection once both are linked.
    let turn = command_with_operation_id(fixture_command("turn_submit.json"), operation_id);
    reserve_operation(&session_ledger, &turn, &test_history(session_id))
        .await
        .unwrap();
    let shutdown = command_with_operation_id(fixture_command("shutdown.json"), operation_id);
    reserve_operation(&host_ledger, &shutdown, &HistoryService::default())
        .await
        .unwrap();
    let linked = HistoryService {
        session_ledger: Some(Arc::new(open_session(dir.path(), session_id))),
        host_ledger: Some(Arc::new(open_host(dir.path()))),
        session_id: Some(session_id),
        probe: Arc::new(praana_core::history::operation_ledger::NullRecoveryProbe),
        now_ms: Arc::new(|| FIXED_NOW_MS),
    };
    // Reopening keeps both rows; a new reservation attempt detects the pair.
    let session_ledger = linked.session_ledger.clone().unwrap();
    let err = reserve_operation(&session_ledger, &turn, &linked)
        .await
        .expect_err("dual-ledger duplicate");
    assert_eq!(err.code, CoreErrorCode::IntegrityFailed);
}

#[tokio::test]
async fn reserved_plan_continues_to_terminal_on_same_id_retry() {
    use praana_core::ui_contract::operation::OperationStatus;
    let dir = tempfile::tempdir().unwrap();
    let session_id = new_session_id();
    let operation_id = new_operation_id();
    let path = dir.path().join("history.db");
    let command = command_with_operation_id(fixture_command("turn_submit.json"), operation_id);
    {
        let ledger = open_session_ledger(&path, session_id).unwrap();
        let reservation = reserve_operation(&ledger, &command, &test_history(session_id))
            .await
            .unwrap();
        assert!(matches!(reservation, OperationReservation::Reserved(_)));
        // Crash between reservation and effect: drop the ledger without
        // completing anything.
    }
    // Reopen after the crash: the reserved plan is intact.
    let ledger = open_session_ledger(&path, session_id).unwrap();
    let stored = ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(stored.dto.status, OperationStatus::Reserved);
    assert!(stored.result_json.is_none());
    assert_eq!(stored.dto.planned_effects.len(), 1);
    // With no effects present and no secret write, recovery leaves the plan
    // reserved for a same-ID retry; nothing is guessed or repeated.
    let session_ledger = Arc::new(open_session_ledger(&path, session_id).unwrap());
    let history = HistoryService {
        session_ledger: Some(session_ledger.clone()),
        host_ledger: None,
        session_id: Some(session_id),
        probe: Arc::new(praana_core::history::operation_ledger::NullRecoveryProbe),
        now_ms: Arc::new(|| FIXED_NOW_MS),
    };
    let notices = recover_reserved_operations(&session_ledger, &history)
        .await
        .unwrap();
    assert_eq!(notices.len(), 1);
    let stored = session_ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(stored.dto.status, OperationStatus::Reserved);
    // The same-ID retry continues the reservation to a stored terminal
    // result instead of being refused.
    let core = CoreServices {
        ledger: session_ledger.clone(),
        history,
        session_id: Some(session_id),
        turn_active: false,
    };
    let result = execute_core_command(&core, command_value(&command)).await;
    let bytes = praana_core::canonical_json::to_canonical_json_bytes(&result).unwrap();
    let stored = session_ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(stored.dto.status, OperationStatus::Failed);
    assert!(stored.dto.result_ref.is_some());
    // A further duplicate replays the stored bytes exactly.
    let again = execute_core_command(&core, command_value(&command)).await;
    assert_eq!(
        bytes,
        praana_core::canonical_json::to_canonical_json_bytes(&again).unwrap()
    );
}

#[tokio::test]
async fn completed_effects_recover_to_stored_success() {
    let dir = tempfile::tempdir().unwrap();
    let session_id = new_session_id();
    let turn_id = TurnId(ulid::Ulid::generate());
    let ledger = open_session(dir.path(), session_id);
    let operation_id = new_operation_id();
    let command = command_with_operation_id(fixture_command("turn_submit.json"), operation_id);
    let reservation = reserve_operation(&ledger, &command, &test_history(session_id))
        .await
        .unwrap();
    let record = match reservation {
        OperationReservation::Reserved(record) => record,
        _ => panic!("expected reservation"),
    };
    let event_id = match &record.planned_effects[..] {
        [PlannedEffectRef::CanonicalEvents { event_ids, .. }] => event_ids[0],
        _ => panic!("expected canonical plan"),
    };
    // Crash after the planned event fsync but before result persistence.
    let success = turn_submitted_result(session_id, turn_id, event_id);
    let probe = FakeProbe {
        present: HashMap::from([((session_id.to_string(), event_id.to_string()), true)]),
        rebuild: Some(RebuiltTerminal {
            result: StoredTerminalResult::Success(success),
            first_seq: Some(43),
            terminal_seq: Some(43),
        }),
    };
    let history = HistoryService {
        probe: Arc::new(probe),
        ..test_history(session_id)
    };
    let notices = recover_reserved_operations(&ledger, &history)
        .await
        .unwrap();
    assert_eq!(notices.len(), 1);
    let stored = ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(
        stored.dto.status,
        praana_core::ui_contract::operation::OperationStatus::Succeeded
    );
    assert_eq!(stored.dto.first_canonical_sequence, Some(43));
    // A matching duplicate now replays the stored bytes exactly.
    let replay = reserve_operation(&ledger, &command, &test_history(session_id))
        .await
        .unwrap();
    match replay {
        OperationReservation::ReplayStored(StoredTerminalResult::Success(replayed)) => {
            let expected = turn_submitted_result(session_id, turn_id, event_id);
            assert_eq!(replayed, expected);
        }
        _ => panic!("expected stored replay"),
    }
}

#[tokio::test]
async fn partial_effects_and_risk_approvals_become_interrupted() {
    let dir = tempfile::tempdir().unwrap();
    let session_id = new_session_id();
    let ledger = open_session(dir.path(), session_id);
    // Partial effects: reserve two ops, prove only one event of the first.
    let first_id = new_operation_id();
    let first = command_with_operation_id(fixture_command("turn_submit.json"), first_id);
    let reservation = reserve_operation(&ledger, &first, &test_history(session_id))
        .await
        .unwrap();
    let record: OperationRecordDto = match reservation {
        OperationReservation::Reserved(record) => record,
        _ => panic!("expected reservation"),
    };
    let event_id = match &record.planned_effects[..] {
        [PlannedEffectRef::CanonicalEvents { event_ids, .. }] => event_ids[0],
        _ => panic!("expected canonical plan"),
    };
    // Risk approval reservation.
    let risk_id = new_operation_id();
    let risk = command_with_operation_id(fixture_command("risk_resolve.json"), risk_id);
    reserve_operation(&ledger, &risk, &test_history(session_id))
        .await
        .unwrap();
    // Probe proves the turn event but offers no rebuild: uncertain outcome.
    let probe = FakeProbe {
        present: HashMap::from([((session_id.to_string(), event_id.to_string()), true)]),
        rebuild: None,
    };
    let history = HistoryService {
        probe: Arc::new(probe),
        ..test_history(session_id)
    };
    let notices = recover_reserved_operations(&ledger, &history)
        .await
        .unwrap();
    assert_eq!(notices.len(), 2);
    let stored = ledger.lookup(&first_id).unwrap().unwrap();
    assert_eq!(
        stored.dto.status,
        praana_core::ui_contract::operation::OperationStatus::Interrupted,
    );
    let stored = ledger.lookup(&risk_id).unwrap().unwrap();
    assert_eq!(
        stored.dto.status,
        praana_core::ui_contract::operation::OperationStatus::Interrupted,
    );
    // Interrupted IDs report OperationInterrupted without executing.
    for command in [&first, &risk] {
        let err = reserve_operation(&ledger, command, &test_history(session_id))
            .await
            .expect_err("interrupted");
        assert_eq!(err.code, CoreErrorCode::OperationInterrupted);
    }
}

#[test]
fn host_settings_reserve_mutate_complete_in_one_transaction() {
    use praana_core::ui_contract::operation::OperationStatus;
    let dir = tempfile::tempdir().unwrap();
    let ledger = open_host(dir.path());
    let before = get_effective_settings(&ledger).unwrap();
    assert_eq!(before.revision, 0);
    // The fixture targets revision 3; this host starts at 0.
    let mut value: serde_json::Value =
        serde_json::to_value(fixture_command("settings_patch.json")).expect("serialize fixture");
    value["data"]["expected_revision"] = serde_json::json!(0);
    let command: CoreCommand = serde_json::from_value(value).expect("reparse");
    let operation_id = command.operation_id().unwrap();
    let history = HistoryService::default();
    // One call reserves, mutates settings, and stores the terminal result.
    // There is no stranded reserved row between reservation and the write.
    let reservation = futures_block_on(reserve_operation(&ledger, &command, &history)).unwrap();
    match reservation {
        OperationReservation::ReplayStored(
            praana_core::ui_contract::operation::StoredTerminalResult::Success(success),
        ) => match success {
            CoreCommandSuccess::SettingsPatched(patched) => {
                assert_eq!(patched.revision, 1);
                assert_eq!(
                    patched.theme,
                    praana_core::ui_contract::settings::ThemeId::HighContrast
                );
            }
            _ => panic!("expected settings_patched"),
        },
        _ => panic!("expected atomic terminal success"),
    }
    let after = get_effective_settings(&ledger).unwrap();
    assert_eq!(after.revision, 1);
    let stored = ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(stored.dto.status, OperationStatus::Succeeded);
    assert_eq!(
        stored.dto.planned_effects,
        vec![PlannedEffectRef::SettingsRevision {
            from_revision: 0,
            to_revision: 1,
        }]
    );
    // A stale expected revision conflicts and writes nothing.
    let stale_id = new_operation_id();
    let stale = command_with_operation_id(fixture_command("settings_patch.json"), stale_id);
    let err = futures_block_on(reserve_operation(&ledger, &stale, &history))
        .expect_err("revision mismatch");
    assert_eq!(err.code, CoreErrorCode::SettingsConflict);
    assert!(ledger.lookup(&stale_id).unwrap().is_none());
}

#[tokio::test]
async fn concurrent_settings_reservations_plan_distinct_revisions() {
    use praana_core::ui_contract::operation::StoredTerminalResult;
    let dir = tempfile::tempdir().unwrap();
    let ledger = Arc::new(open_host(dir.path()));
    let history = Arc::new(HistoryService::default());
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let reserve_one = |ledger: Arc<OperationLedger>,
                       history: Arc<HistoryService>,
                       barrier: Arc<tokio::sync::Barrier>| async move {
        let mut value: serde_json::Value =
            serde_json::to_value(fixture_command("settings_patch.json")).expect("serialize");
        value["data"]["expected_revision"] = serde_json::json!(0);
        let command: CoreCommand = serde_json::from_value(value).expect("reparse");
        let command = command_with_operation_id(command, new_operation_id());
        barrier.wait().await;
        reserve_operation(&ledger, &command, &history).await
    };
    let (first, second) = tokio::join!(
        reserve_one(ledger.clone(), history.clone(), barrier.clone()),
        reserve_one(ledger.clone(), history.clone(), barrier.clone())
    );
    // Exactly one reservation wins revision 0->1 as a terminal row; the loser
    // observes the advanced revision and conflicts. No two rows ever plan
    // from the same revision, and no reserved row is stranded.
    let mut succeeded = 0;
    let mut conflicted = 0;
    for result in [first, second] {
        match result {
            Ok(OperationReservation::ReplayStored(StoredTerminalResult::Success(
                CoreCommandSuccess::SettingsPatched(patched),
            ))) => {
                assert_eq!(patched.revision, 1);
                succeeded += 1;
            }
            Err(error) => {
                assert_eq!(error.code, CoreErrorCode::SettingsConflict);
                conflicted += 1;
            }
            _ => panic!("unexpected reservation outcome"),
        }
    }
    assert_eq!(succeeded, 1);
    assert_eq!(conflicted, 1);
    assert_eq!(get_effective_settings(&ledger).unwrap().revision, 1);
    assert_eq!(
        ledger.list_reserved().unwrap().len(),
        0,
        "no stranded reserved rows"
    );
}

fn futures_block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

#[test]
fn host_journal_lifecycle_replaces_and_commits_then_cleans_up() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let journal_dir = dir.path().join("ui-operation-journals");
    let ledger = open_host(dir.path());
    let target = home.join("credentials.json");
    std::fs::write(&target, b"{}").unwrap();

    let operation_id = new_operation_id();
    let auth = command_with_operation_id(fixture_command("auth_login_device.json"), operation_id);
    let history = HistoryService::default();
    futures_block_on(reserve_operation(&ledger, &auth, &history)).unwrap();

    let before_bytes = b"{}".to_vec();
    let after_bytes = br#"{"openai":"present"}"#.to_vec();
    let mut journal = HostOperationJournalV1 {
        schema_version: 1,
        operation_id,
        operation_kind: OperationKind::AuthLogin,
        target_label: HostStateTarget::Credentials,
        before_revision: 0,
        after_revision: 1,
        before_sha256: sha256_hex_of(&before_bytes),
        after_sha256: sha256_hex_of(&after_bytes),
        before_file_sha256: sha256_hex_of(&before_bytes),
        after_file_sha256: sha256_hex_of(&after_bytes),
        stage: HostJournalStage::Prepared,
        created_at_ms: FIXED_NOW_MS,
    };
    let paths = journal_prepare(&journal_dir, &journal, &before_bytes, &after_bytes).unwrap();
    // Spec sibling layout: <id>.json / <id>.before / <id>.after, no
    // subdirectory and no manifest.json.
    assert_eq!(paths, journal_paths_for(&journal_dir, &operation_id));
    assert!(paths.manifest.exists());
    assert!(paths.before.exists());
    assert!(paths.after.exists());
    assert!(!journal_dir.join(operation_id.to_string()).exists());
    assert!(!journal_dir.join("manifest.json").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [&paths.manifest, &paths.before, &paths.after] {
            assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(
            journal_dir.metadata().unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    // Crash between replacement and revision commit is recoverable: replace
    // the target, then commit the revision and terminal result together.
    journal_replace_target(&journal_dir, &mut journal, &home).unwrap();
    assert_eq!(journal.stage, HostJournalStage::Replaced);
    assert_eq!(std::fs::read(&target).unwrap(), after_bytes);

    let success =
        CoreCommandSuccess::AuthLogin(praana_core::ui_contract::setup::AuthLoginResultDto {
            provider: "openai".parse().unwrap(),
            state: praana_core::ui_contract::setup::AuthState::Authenticated,
            flow: None,
        });
    journal_commit_revision(
        &ledger,
        &journal_dir,
        &mut journal,
        &StoredTerminalResult::Success(success),
        FIXED_NOW_MS,
    )
    .unwrap();
    assert_eq!(journal.stage, HostJournalStage::RevisionCommitted);
    let revision = get_host_revision(&ledger, "credentials").unwrap();
    assert_eq!(revision.revision, 1);

    // Journal files are removed only after terminal durability.
    journal_cleanup(&journal_dir, &operation_id).unwrap();
    assert!(!paths.manifest.exists());
    assert!(!paths.before.exists());
    assert!(!paths.after.exists());
    let stored = ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(
        stored.dto.status,
        praana_core::ui_contract::operation::OperationStatus::Succeeded
    );
    // The terminal row reconstructs its result reference.
    let result_ref = stored.dto.result_ref.expect("terminal result_ref");
    match result_ref.ledger {
        praana_core::ui_contract::operation::OperationLedgerRef::Host => {}
        _ => panic!("host-scoped reference"),
    }
}

#[test]
fn host_journal_recovery_marks_before_as_interrupted_and_keeps_mixed() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let journal_dir = dir.path().join("ui-operation-journals");
    let ledger = open_host(dir.path());
    let history = HistoryService {
        now_ms: Arc::new(|| FIXED_NOW_MS),
        ..HistoryService::default()
    };

    // Case 1: crash before replacement (exact before state).
    let untouched_id = new_operation_id();
    let auth = command_with_operation_id(fixture_command("auth_login_device.json"), untouched_id);
    futures_block_on(reserve_operation(&ledger, &auth, &history)).unwrap();
    let before_bytes = b"{}".to_vec();
    let after_bytes = br#"{"openai":"present"}"#.to_vec();
    std::fs::write(home.join("credentials.json"), &before_bytes).unwrap();
    let untouched_journal = HostOperationJournalV1 {
        schema_version: 1,
        operation_id: untouched_id,
        operation_kind: OperationKind::AuthLogin,
        target_label: HostStateTarget::Credentials,
        before_revision: 0,
        after_revision: 1,
        before_sha256: sha256_hex_of(&before_bytes),
        after_sha256: sha256_hex_of(&after_bytes),
        before_file_sha256: sha256_hex_of(&before_bytes),
        after_file_sha256: sha256_hex_of(&after_bytes),
        stage: HostJournalStage::Prepared,
        created_at_ms: FIXED_NOW_MS,
    };
    journal_prepare(
        &journal_dir,
        &untouched_journal,
        &before_bytes,
        &after_bytes,
    )
    .unwrap();

    // Case 2: mixed state (target replaced, revision not committed).
    let mixed_id = new_operation_id();
    let mixed_auth = command_with_operation_id(fixture_command("auth_login_device.json"), mixed_id);
    futures_block_on(reserve_operation(&ledger, &mixed_auth, &history)).unwrap();
    std::fs::write(home.join("setup-config.json"), &after_bytes).unwrap();
    let mixed_journal = HostOperationJournalV1 {
        schema_version: 1,
        operation_id: mixed_id,
        operation_kind: OperationKind::SetupApply,
        target_label: HostStateTarget::SetupConfig,
        before_revision: 0,
        after_revision: 1,
        before_sha256: sha256_hex_of(&before_bytes),
        after_sha256: sha256_hex_of(&after_bytes),
        before_file_sha256: sha256_hex_of(&before_bytes),
        after_file_sha256: sha256_hex_of(&after_bytes),
        stage: HostJournalStage::Replaced,
        created_at_ms: FIXED_NOW_MS,
    };
    journal_prepare(&journal_dir, &mixed_journal, &before_bytes, &after_bytes).unwrap();

    // Case 3: exact after state with a reserved row (crash between replace
    // and commit while the target already matches): the terminal result is
    // stored through the probe, then the journal is cleaned up.
    let applied_id = new_operation_id();
    let applied_auth =
        command_with_operation_id(fixture_command("auth_login_device.json"), applied_id);
    futures_block_on(reserve_operation(&ledger, &applied_auth, &history)).unwrap();
    std::fs::write(home.join("consent.json"), &after_bytes).unwrap();
    {
        let conn = rusqlite::Connection::open(dir.path().join("ui-operations.db")).unwrap();
        conn.execute(
            "UPDATE host_revisions SET revision = 1 WHERE state_kind = 'consent';",
            [],
        )
        .unwrap();
    }
    let applied_journal = HostOperationJournalV1 {
        schema_version: 1,
        operation_id: applied_id,
        operation_kind: OperationKind::ConsentResolve,
        target_label: HostStateTarget::Consent,
        before_revision: 0,
        after_revision: 1,
        before_sha256: sha256_hex_of(&before_bytes),
        after_sha256: sha256_hex_of(&after_bytes),
        before_file_sha256: sha256_hex_of(&before_bytes),
        after_file_sha256: sha256_hex_of(&after_bytes),
        stage: HostJournalStage::Replaced,
        created_at_ms: FIXED_NOW_MS,
    };
    journal_prepare(&journal_dir, &applied_journal, &before_bytes, &after_bytes).unwrap();
    let rebuilt_success = CoreCommandSuccess::ConsentResolved(
        praana_core::ui_contract::setup::ConsentResolvedResultDto {
            consent_id: "01J8Z3NDEK000000000000000A".parse().unwrap(),
            decision: praana_core::ui_contract::setup::ConsentChoice::AllowPersisted,
            persisted: true,
        },
    );
    let history = HistoryService {
        probe: Arc::new(FakeProbe {
            present: HashMap::new(),
            rebuild: Some(RebuiltTerminal {
                result: StoredTerminalResult::Success(rebuilt_success),
                first_seq: None,
                terminal_seq: None,
            }),
        }),
        now_ms: Arc::new(|| FIXED_NOW_MS),
        ..HistoryService::default()
    };

    let notices = recover_host_journal(&ledger, &journal_dir, &home, &history).unwrap();
    assert_eq!(notices.len(), 3);
    // Exact-before work never took effect: interrupted, journal removed, and
    // a new operation with a fresh ID is permitted.
    let stored = ledger.lookup(&untouched_id).unwrap().unwrap();
    assert_eq!(
        stored.dto.status,
        praana_core::ui_contract::operation::OperationStatus::Interrupted
    );
    assert!(!journal_paths_for(&journal_dir, &untouched_id)
        .manifest
        .exists());
    // Mixed state is interrupted but the journal siblings are preserved for
    // visible manual recovery.
    let stored = ledger.lookup(&mixed_id).unwrap().unwrap();
    assert_eq!(
        stored.dto.status,
        praana_core::ui_contract::operation::OperationStatus::Interrupted
    );
    assert!(journal_paths_for(&journal_dir, &mixed_id).manifest.exists());
    // Exact-after work proves success: terminal result stored, journal gone.
    let stored = ledger.lookup(&applied_id).unwrap().unwrap();
    assert_eq!(
        stored.dto.status,
        praana_core::ui_contract::operation::OperationStatus::Succeeded
    );
    assert!(!journal_paths_for(&journal_dir, &applied_id)
        .manifest
        .exists());
}

#[test]
fn host_retention_prunes_only_old_unreferenced_terminal_rows() {
    let dir = tempfile::tempdir().unwrap();
    let ledger = open_host(dir.path());
    let history = HistoryService::default();
    let live_session = new_session_id().to_string();

    // Old terminal row without a session reference: pruned.
    let pruned_id = new_operation_id();
    let shutdown = command_with_operation_id(fixture_command("shutdown.json"), pruned_id);
    let reservation = futures_block_on(reserve_operation(&ledger, &shutdown, &history)).unwrap();
    let record = match reservation {
        OperationReservation::Reserved(record) => record,
        _ => panic!("expected reservation"),
    };
    let error = praana_core::ui_contract::result::CoreErrorDto {
        code: CoreErrorCode::Cancelled,
        message: "done".to_string(),
        retry: praana_core::ui_contract::result::ErrorRetryAdvice::NewOperation,
        details: praana_core::ui_contract::result::ErrorDetailsDto::None,
    };
    ledger
        .complete_terminal(
            &pruned_id,
            &StoredTerminalResult::Error(error),
            None,
            None,
            FIXED_NOW_MS,
        )
        .unwrap();
    let _ = record;

    // Old terminal row referenced by a live session: retained. Age it with a
    // direct timestamp update so the stored result hash stays valid.
    let kept_id = new_operation_id();
    let kept_shutdown = command_with_operation_id(fixture_command("shutdown.json"), kept_id);
    futures_block_on(reserve_operation(&ledger, &kept_shutdown, &history)).unwrap();
    let kept_error = praana_core::ui_contract::result::CoreErrorDto {
        code: CoreErrorCode::Cancelled,
        message: "done".to_string(),
        retry: praana_core::ui_contract::result::ErrorRetryAdvice::NewOperation,
        details: praana_core::ui_contract::result::ErrorDetailsDto::None,
    };
    ledger
        .complete_terminal(
            &kept_id,
            &StoredTerminalResult::Error(kept_error),
            None,
            None,
            FIXED_NOW_MS,
        )
        .unwrap();
    {
        let conn = rusqlite::Connection::open(dir.path().join("ui-operations.db")).unwrap();
        conn.execute(
            "UPDATE operation_records SET finished_at_ms = ?1, session_id = ?2 WHERE operation_id = ?3;",
            rusqlite::params![
                FIXED_NOW_MS - HOST_PRUNE_AFTER_MS - 1_000,
                live_session,
                kept_id.to_string()
            ],
        )
        .unwrap();
        conn.execute(
            "UPDATE operation_records SET finished_at_ms = ?1 WHERE operation_id = ?2;",
            rusqlite::params![
                FIXED_NOW_MS - HOST_PRUNE_AFTER_MS - 1_000,
                pruned_id.to_string()
            ],
        )
        .unwrap();
    }

    // Reserved rows are never age-pruned.
    let reserved_id = new_operation_id();
    let reserved = command_with_operation_id(fixture_command("shutdown.json"), reserved_id);
    futures_block_on(reserve_operation(&ledger, &reserved, &history)).unwrap();

    let pruned =
        prune_host_terminal(&ledger, FIXED_NOW_MS, &HashSet::from([live_session])).unwrap();
    assert_eq!(pruned, 1);
    assert!(ledger.lookup(&pruned_id).unwrap().is_none());
    assert!(ledger.lookup(&kept_id).unwrap().is_some());
    assert!(ledger.lookup(&reserved_id).unwrap().is_some());
}

#[test]
fn session_records_are_retained_until_session_deletion() {
    // Session ledgers apply no age pruning: records live until the whole
    // session store is deleted.
    let dir = tempfile::tempdir().unwrap();
    let session_id = new_session_id();
    let session_ledger = open_session(dir.path(), session_id);
    let history = test_history(session_id);
    let operation_id = new_operation_id();
    let command = command_with_operation_id(fixture_command("turn_submit.json"), operation_id);
    futures_block_on(reserve_operation(&session_ledger, &command, &history)).unwrap();
    assert_eq!(
        prune_host_terminal(&session_ledger, FIXED_NOW_MS, &HashSet::new()).unwrap(),
        0
    );
    assert!(session_ledger.lookup(&operation_id).unwrap().is_some());
}

#[test]
fn corrupt_rows_and_schema_block_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let session_id = new_session_id();
    let ledger = open_session(dir.path(), session_id);
    let history = test_history(session_id);
    let operation_id = new_operation_id();
    let command = command_with_operation_id(fixture_command("turn_submit.json"), operation_id);
    let reservation = futures_block_on(reserve_operation(&ledger, &command, &history)).unwrap();
    assert!(matches!(reservation, OperationReservation::Reserved(_)));
    // Complete, then corrupt the stored result hash with a valid-length but
    // wrong digest: reads and further mutation must block.
    let error = praana_core::ui_contract::result::CoreErrorDto {
        code: CoreErrorCode::Cancelled,
        message: "done".to_string(),
        retry: praana_core::ui_contract::result::ErrorRetryAdvice::NewOperation,
        details: praana_core::ui_contract::result::ErrorDetailsDto::None,
    };
    ledger
        .complete_terminal(
            &operation_id,
            &StoredTerminalResult::Error(error),
            None,
            None,
            FIXED_NOW_MS,
        )
        .unwrap();
    {
        let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        conn.execute(
            "UPDATE operation_records SET result_sha256 = ?1 WHERE operation_id = ?2;",
            rusqlite::params!["f".repeat(64), operation_id.to_string()],
        )
        .unwrap();
    }
    let err = ledger.lookup(&operation_id).expect_err("corrupt row");
    assert!(err.to_string().contains("HISTORY_OPERATION_LEDGER_CORRUPT"));
    let err = futures_block_on(reserve_operation(&ledger, &command, &history))
        .expect_err("corrupt row blocks mutation");
    assert_eq!(err.code, CoreErrorCode::IntegrityFailed);

    // Bad schema_meta blocks opening.
    {
        let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        conn.execute(
            "UPDATE schema_meta SET value = '2' WHERE key = 'ui_contract_schema_version';",
            [],
        )
        .unwrap();
    }
    drop(ledger);
    let err = match open_session_ledger(&dir.path().join("history.db"), session_id) {
        Ok(_) => panic!("bad schema blocks open"),
        Err(err) => err,
    };
    assert!(err.to_string().contains("HISTORY_OPERATION_LEDGER_CORRUPT"));
}

#[test]
fn ledgers_apply_sqlite_pragmas_with_full_synchronization() {
    let dir = tempfile::tempdir().unwrap();
    let session_id = new_session_id();
    let session_path = dir.path().join("history.db");
    let host_path = dir.path().join("ui-operations.db");
    drop(open_session_ledger(&session_path, session_id).unwrap());
    drop(open_host_ledger(&host_path).unwrap());
    for path in [&session_path, &host_path] {
        let conn = rusqlite::Connection::open(path).unwrap();
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode;", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journal_mode.to_lowercase(), "wal", "{}", path.display());
        let synchronous: i32 = conn
            .query_row("PRAGMA synchronous;", [], |row| row.get(0))
            .unwrap();
        assert_eq!(synchronous, 2, "{}", path.display());
        let foreign_keys: i32 = conn
            .query_row("PRAGMA foreign_keys;", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1, "{}", path.display());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{}", path.display());
        }
    }
}

#[test]
fn secrets_never_reach_sqlite_journals_or_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let ledger = open_host(dir.path());
    let history = HistoryService::default();
    let secret = "sk-live-secret-7f3a9c2e";
    let command = setup_apply_with_secret(secret);
    let operation_id = command.operation_id().unwrap();
    futures_block_on(reserve_operation(&ledger, &command, &history)).unwrap();
    // Conflict diagnostics carry only the existing request hash.
    let mut different = setup_apply_with_secret("sk-other-secret");
    different = command_with_operation_id(different, operation_id);
    let conflict =
        futures_block_on(reserve_operation(&ledger, &different, &history)).expect_err("conflict");
    assert_eq!(conflict.code, CoreErrorCode::OperationConflict);
    let diagnostics = serde_json::to_string(&conflict).unwrap();
    assert!(!diagnostics.contains(secret));
    // The ledger file contains hashes, never plaintext.
    let bytes = std::fs::read(dir.path().join("ui-operations.db")).unwrap();
    assert!(!windows_contains(&bytes, secret.as_bytes()));
    // Command Debug rendering is redacted.
    let rendered = format!("{command:?}");
    assert!(!rendered.contains(secret));
    assert!(rendered.contains("[REDACTED]"));
}

fn windows_contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[test]
fn operation_scopes_route_to_session_or_host_ledgers() {
    let session_ledger = LedgerScope::Session {
        session_id: new_session_id(),
    };
    let host_ledger = LedgerScope::Host;
    assert!(matches!(session_ledger, LedgerScope::Session { .. }));
    assert!(matches!(host_ledger, LedgerScope::Host));
    // Host kinds from section 10 plus persisted consent.
    for kind in [
        OperationKind::SessionCreate,
        OperationKind::SessionNew,
        OperationKind::SettingsPatch,
        OperationKind::SetupApply,
        OperationKind::AuthLogin,
        OperationKind::AuthLogout,
        OperationKind::ConsentResolve,
        OperationKind::Shutdown,
    ] {
        assert!(
            praana_core::history::operation_ledger::host_scoped_kind(&kind),
            "{kind:?}"
        );
    }
    for kind in [
        OperationKind::TurnSubmit,
        OperationKind::RiskResolve,
        OperationKind::SlashExecute,
    ] {
        assert!(
            !praana_core::history::operation_ledger::host_scoped_kind(&kind),
            "{kind:?}"
        );
    }
}

#[tokio::test]
async fn session_busy_rules_admit_only_turn_scoped_commands() {
    let dir = tempfile::tempdir().unwrap();
    let session_id = new_session_id();
    let session_ledger = Arc::new(open_session(dir.path(), session_id));
    let history = HistoryService {
        session_ledger: Some(session_ledger.clone()),
        host_ledger: None,
        session_id: Some(session_id),
        probe: Arc::new(praana_core::history::operation_ledger::NullRecoveryProbe),
        now_ms: Arc::new(|| FIXED_NOW_MS),
    };
    let busy = CoreServices {
        ledger: session_ledger,
        history,
        session_id: Some(session_id),
        turn_active: true,
    };
    // Non-admitted mutation during an active turn.
    let submit = command_with_operation_id(fixture_command("turn_submit.json"), new_operation_id());
    match execute_core_command(&busy, command_value(&submit)).await {
        CoreCommandResult::Err(error) => assert_eq!(error.code, CoreErrorCode::SessionBusy),
        _ => panic!("expected session busy"),
    }
    // TurnCancel is admitted and proceeds to honest reservation.
    let cancel = command_with_operation_id(fixture_command("turn_cancel.json"), new_operation_id());
    match execute_core_command(&busy, command_value(&cancel)).await {
        CoreCommandResult::Err(error) => assert_eq!(error.code, CoreErrorCode::Unavailable),
        _ => panic!("expected unavailable terminal"),
    }
    // Read-only ping answers locally without a ledger effect.
    let ping = fixture_command("runtime_ping.json");
    match execute_core_command(&busy, ping).await {
        CoreCommandResult::Ok(CoreCommandSuccess::RuntimePong(pong)) => {
            assert_eq!(pong.session_id, Some(session_id));
        }
        _ => panic!("expected pong"),
    }
}

#[test]
fn terminal_rows_reconstruct_scoped_result_refs() {
    use praana_core::ui_contract::operation::{OperationLedgerRef, OperationStatus};
    let dir = tempfile::tempdir().unwrap();
    // Session row: reserve then complete through the honest boundary.
    let session_id = new_session_id();
    let session_ledger = Arc::new(open_session(dir.path(), session_id));
    let history = HistoryService {
        session_ledger: Some(session_ledger.clone()),
        host_ledger: None,
        session_id: Some(session_id),
        probe: Arc::new(praana_core::history::operation_ledger::NullRecoveryProbe),
        now_ms: Arc::new(|| FIXED_NOW_MS),
    };
    let core = CoreServices {
        ledger: session_ledger.clone(),
        history,
        session_id: Some(session_id),
        turn_active: false,
    };
    let operation_id = new_operation_id();
    let command = command_with_operation_id(fixture_command("turn_submit.json"), operation_id);
    let result = futures_block_on(execute_core_command(&core, command_value(&command)));
    let stored = session_ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(stored.dto.status, OperationStatus::Failed);
    let result_ref = stored.dto.result_ref.expect("terminal result_ref");
    match &result_ref.ledger {
        OperationLedgerRef::Session { session_id: scope } => assert_eq!(*scope, session_id),
        _ => panic!("session-scoped reference"),
    }
    assert_eq!(result_ref.operation_id, operation_id);
    assert_eq!(result_ref.ui_contract_schema_version, 1);
    // The digest matches the stored terminal DTO bytes (the hash covers the
    // complete terminal error/success DTO, not the result envelope).
    let inner = match &result {
        CoreCommandResult::Err(error) => {
            praana_core::canonical_json::to_canonical_json_bytes(error).unwrap()
        }
        CoreCommandResult::Ok(success) => {
            praana_core::canonical_json::to_canonical_json_bytes(success).unwrap()
        }
    };
    assert_eq!(
        result_ref.result_sha256,
        sha256_hex_of(&inner),
        "result_ref digest must match stored bytes"
    );
    // Reserved rows carry no reference.
    let reserved_id = new_operation_id();
    let reserved = command_with_operation_id(fixture_command("turn_cancel.json"), reserved_id);
    futures_block_on(reserve_operation(
        &session_ledger,
        &reserved,
        &test_history(session_id),
    ))
    .unwrap();
    let stored = session_ledger.lookup(&reserved_id).unwrap().unwrap();
    assert_eq!(stored.dto.status, OperationStatus::Reserved);
    assert!(stored.dto.result_ref.is_none());

    // Host row: the atomic settings path stores a host-scoped reference.
    let host_ledger = open_host(dir.path());
    let mut value: serde_json::Value =
        serde_json::to_value(fixture_command("settings_patch.json")).expect("serialize");
    value["data"]["expected_revision"] = serde_json::json!(0);
    let settings: CoreCommand = serde_json::from_value(value).expect("reparse");
    let settings_id = settings.operation_id().unwrap();
    futures_block_on(reserve_operation(
        &host_ledger,
        &settings,
        &HistoryService::default(),
    ))
    .unwrap();
    let stored = host_ledger.lookup(&settings_id).unwrap().unwrap();
    let result_ref = stored.dto.result_ref.expect("terminal result_ref");
    assert!(matches!(result_ref.ledger, OperationLedgerRef::Host));
    let json = stored.result_json.expect("terminal bytes");
    let bytes = praana_core::canonical_json::to_canonical_json_bytes(
        &serde_json::from_str::<serde_json::Value>(&json).unwrap(),
    )
    .unwrap();
    assert_eq!(result_ref.result_sha256, sha256_hex_of(&bytes));
}

#[tokio::test]
async fn device_login_without_secrets_retries_after_crash() {
    use praana_core::ui_contract::operation::OperationStatus;
    let dir = tempfile::tempdir().unwrap();
    let ledger = open_host(dir.path());
    let history = HistoryService::default();
    let operation_id = new_operation_id();
    let command =
        command_with_operation_id(fixture_command("auth_login_device.json"), operation_id);
    // The device-code plan carries no secret write.
    let reservation = reserve_operation(&ledger, &command, &history)
        .await
        .unwrap();
    match &reservation {
        OperationReservation::Reserved(record) => {
            assert!(
                !record
                    .planned_effects
                    .iter()
                    .any(|effect| matches!(effect, PlannedEffectRef::NonReplayableSecretWrite)),
                "device login must not plan a secret write"
            );
        }
        _ => panic!("expected reservation"),
    }
    drop(ledger);
    // Crash before replacement, then recover: nothing is proven, nothing is
    // secret-bearing, so the plan stays reserved.
    let ledger = open_host(dir.path());
    let notices = recover_reserved_operations(&ledger, &history)
        .await
        .unwrap();
    assert_eq!(notices.len(), 1);
    let stored = ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(stored.dto.status, OperationStatus::Reserved);
    // The same-ID retry continues instead of being interrupted.
    let replay = reserve_operation(&ledger, &command, &history)
        .await
        .unwrap();
    assert!(matches!(replay, OperationReservation::Reserved(_)));
}

#[test]
fn result_guard_rejects_either_secret_marker() {
    let dir = tempfile::tempdir().unwrap();
    let session_id = new_session_id();
    let ledger = open_session(dir.path(), session_id);
    let history = test_history(session_id);
    let operation_id = new_operation_id();
    let command = command_with_operation_id(fixture_command("turn_submit.json"), operation_id);
    futures_block_on(reserve_operation(&ledger, &command, &history)).unwrap();
    // A result carrying only the "sk-" marker fails closed.
    let error = praana_core::ui_contract::result::CoreErrorDto {
        code: CoreErrorCode::Unavailable,
        message: "key sk-test-only leaked".to_string(),
        retry: praana_core::ui_contract::result::ErrorRetryAdvice::Never,
        details: praana_core::ui_contract::result::ErrorDetailsDto::None,
    };
    let err = ledger
        .complete_terminal(
            &operation_id,
            &StoredTerminalResult::Error(error),
            None,
            None,
            FIXED_NOW_MS,
        )
        .expect_err("sk- marker must fail closed");
    assert!(err.to_string().contains("HISTORY_OPERATION_LEDGER_CORRUPT"));
    // The row is still reserved and continuable.
    let stored = ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(
        stored.dto.status,
        praana_core::ui_contract::operation::OperationStatus::Reserved
    );
}

#[test]
fn ledger_open_rejects_symlinks_and_locks_down_sidecars() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real.db");
    let link = dir.path().join("link.db");
    // A symlinked database path is rejected, never followed.
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real, &link).unwrap();
    #[cfg(unix)]
    {
        let err = match open_session_ledger(&link, new_session_id()) {
            Ok(_) => panic!("symlink must be rejected"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains("HISTORY_INSECURE_PERMISSIONS"),
            "{err}"
        );
    }
    // Normal open plus a write transaction: WAL/SHM sidecars stay private.
    let session_id = new_session_id();
    let ledger = open_session_ledger(&real, session_id).unwrap();
    let history = test_history(session_id);
    let command =
        command_with_operation_id(fixture_command("turn_submit.json"), new_operation_id());
    futures_block_on(reserve_operation(&ledger, &command, &history)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for suffix in ["-wal", "-shm"] {
            let sidecar = dir.path().join(format!("real.db{suffix}"));
            if sidecar.exists() {
                assert_eq!(
                    sidecar.metadata().unwrap().permissions().mode() & 0o777,
                    0o600,
                    "{suffix}"
                );
            }
        }
        // The main database file is private too.
        assert_eq!(real.metadata().unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[test]
fn exact_after_journal_reconstructs_auth_login_without_probe() {
    use praana_core::ui_contract::operation::OperationStatus;
    use praana_core::ui_contract::setup::AuthState;
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let journal_dir = dir.path().join("ui-operation-journals");
    let ledger = open_host(dir.path());
    let history = HistoryService {
        now_ms: Arc::new(|| FIXED_NOW_MS),
        ..HistoryService::default()
    };
    // Reserve, then simulate a crash between replace and commit with the
    // target already matching the after bytes at the after revision.
    let operation_id = new_operation_id();
    let auth = command_with_operation_id(fixture_command("auth_login_device.json"), operation_id);
    futures_block_on(reserve_operation(&ledger, &auth, &history)).unwrap();
    let before_bytes = b"{}".to_vec();
    let after_bytes = br#"{"openai":"present"}"#.to_vec();
    std::fs::write(home.join("credentials.json"), &after_bytes).unwrap();
    {
        let conn = rusqlite::Connection::open(dir.path().join("ui-operations.db")).unwrap();
        conn.execute(
            "UPDATE host_revisions SET revision = 1 WHERE state_kind = 'credentials';",
            [],
        )
        .unwrap();
    }
    let journal = HostOperationJournalV1 {
        schema_version: 1,
        operation_id,
        operation_kind: OperationKind::AuthLogin,
        target_label: HostStateTarget::Credentials,
        before_revision: 0,
        after_revision: 1,
        before_sha256: sha256_hex_of(&before_bytes),
        after_sha256: sha256_hex_of(&after_bytes),
        before_file_sha256: sha256_hex_of(&before_bytes),
        after_file_sha256: sha256_hex_of(&after_bytes),
        stage: HostJournalStage::Replaced,
        created_at_ms: FIXED_NOW_MS,
    };
    journal_prepare(&journal_dir, &journal, &before_bytes, &after_bytes).unwrap();
    // Exact-after identity proves success. Reconstruct AuthLogin from the
    // credential object keys (never from secret values) without a probe.
    let notices = recover_host_journal(&ledger, &journal_dir, &home, &history).unwrap();
    assert_eq!(notices.len(), 1);
    let stored = ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(stored.dto.status, OperationStatus::Succeeded);
    assert!(!journal_paths_for(&journal_dir, &operation_id)
        .manifest
        .exists());
    let success: CoreCommandSuccess =
        serde_json::from_str(stored.result_json.as_deref().expect("result")).unwrap();
    match success {
        CoreCommandSuccess::AuthLogin(dto) => {
            assert_eq!(dto.provider.as_str(), "openai");
            assert_eq!(dto.state, AuthState::Authenticated);
            assert!(dto.flow.is_none());
        }
        other => panic!("expected AuthLogin, got {other:?}"),
    }
    // Same-ID retry returns the stored terminal result.
    let replay = futures_block_on(reserve_operation(&ledger, &auth, &history)).unwrap();
    assert!(matches!(replay, OperationReservation::ReplayStored(_)));
}

#[test]
fn exact_after_journal_without_unique_provider_stays_reserved() {
    use praana_core::ui_contract::operation::OperationStatus;
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let journal_dir = dir.path().join("ui-operation-journals");
    let ledger = open_host(dir.path());
    let history = HistoryService {
        now_ms: Arc::new(|| FIXED_NOW_MS),
        ..HistoryService::default()
    };
    let operation_id = new_operation_id();
    let auth = command_with_operation_id(fixture_command("auth_login_device.json"), operation_id);
    futures_block_on(reserve_operation(&ledger, &auth, &history)).unwrap();
    let before_bytes = b"{}".to_vec();
    let after_bytes = br#"{"openai":"present","anthropic":"present"}"#.to_vec();
    std::fs::write(home.join("credentials.json"), &after_bytes).unwrap();
    {
        let conn = rusqlite::Connection::open(dir.path().join("ui-operations.db")).unwrap();
        conn.execute(
            "UPDATE host_revisions SET revision = 1 WHERE state_kind = 'credentials';",
            [],
        )
        .unwrap();
    }
    let journal = HostOperationJournalV1 {
        schema_version: 1,
        operation_id,
        operation_kind: OperationKind::AuthLogin,
        target_label: HostStateTarget::Credentials,
        before_revision: 0,
        after_revision: 1,
        before_sha256: sha256_hex_of(&before_bytes),
        after_sha256: sha256_hex_of(&after_bytes),
        before_file_sha256: sha256_hex_of(&before_bytes),
        after_file_sha256: sha256_hex_of(&after_bytes),
        stage: HostJournalStage::Replaced,
        created_at_ms: FIXED_NOW_MS,
    };
    journal_prepare(&journal_dir, &journal, &before_bytes, &after_bytes).unwrap();
    // Two added providers cannot be mapped onto one AuthLogin result without
    // guessing. Stay reserved and keep the journal for a same-ID retry.
    let notices = recover_host_journal(&ledger, &journal_dir, &home, &history).unwrap();
    assert_eq!(notices.len(), 1);
    let stored = ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(stored.dto.status, OperationStatus::Reserved);
    assert!(journal_paths_for(&journal_dir, &operation_id)
        .manifest
        .exists());
    let replay = futures_block_on(reserve_operation(&ledger, &auth, &history)).unwrap();
    assert!(matches!(replay, OperationReservation::Reserved(_)));
}

#[test]
fn exact_after_journal_swap_stays_reserved() {
    use praana_core::ui_contract::operation::OperationStatus;
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let journal_dir = dir.path().join("ui-operation-journals");
    let ledger = open_host(dir.path());
    let history = HistoryService {
        now_ms: Arc::new(|| FIXED_NOW_MS),
        ..HistoryService::default()
    };
    let operation_id = new_operation_id();
    let auth = command_with_operation_id(fixture_command("auth_login_device.json"), operation_id);
    futures_block_on(reserve_operation(&ledger, &auth, &history)).unwrap();
    let before_bytes = br#"{"openai":"present"}"#.to_vec();
    let after_bytes = br#"{"anthropic":"present"}"#.to_vec();
    std::fs::write(home.join("credentials.json"), &after_bytes).unwrap();
    {
        let conn = rusqlite::Connection::open(dir.path().join("ui-operations.db")).unwrap();
        conn.execute(
            "UPDATE host_revisions SET revision = 1 WHERE state_kind = 'credentials';",
            [],
        )
        .unwrap();
    }
    let journal = HostOperationJournalV1 {
        schema_version: 1,
        operation_id,
        operation_kind: OperationKind::AuthLogin,
        target_label: HostStateTarget::Credentials,
        before_revision: 0,
        after_revision: 1,
        before_sha256: sha256_hex_of(&before_bytes),
        after_sha256: sha256_hex_of(&after_bytes),
        before_file_sha256: sha256_hex_of(&before_bytes),
        after_file_sha256: sha256_hex_of(&after_bytes),
        stage: HostJournalStage::Replaced,
        created_at_ms: FIXED_NOW_MS,
    };
    journal_prepare(&journal_dir, &journal, &before_bytes, &after_bytes).unwrap();
    // A swap is not a unique login. Do not fabricate AuthLogin for the added key.
    let notices = recover_host_journal(&ledger, &journal_dir, &home, &history).unwrap();
    assert_eq!(notices.len(), 1);
    let stored = ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(stored.dto.status, OperationStatus::Reserved);
    assert!(journal_paths_for(&journal_dir, &operation_id)
        .manifest
        .exists());
}

#[test]
fn journal_read_and_recovery_reject_sibling_hash_mismatch() {
    use praana_core::history::operation_ledger::{journal_read, LedgerError};
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let journal_dir = dir.path().join("ui-operation-journals");
    let ledger = open_host(dir.path());
    let history = HistoryService {
        now_ms: Arc::new(|| FIXED_NOW_MS),
        ..HistoryService::default()
    };
    let operation_id = new_operation_id();
    let auth = command_with_operation_id(fixture_command("auth_login_device.json"), operation_id);
    futures_block_on(reserve_operation(&ledger, &auth, &history)).unwrap();
    let before_bytes = b"{}".to_vec();
    let after_bytes = br#"{"openai":"present"}"#.to_vec();
    std::fs::write(home.join("credentials.json"), &after_bytes).unwrap();
    {
        let conn = rusqlite::Connection::open(dir.path().join("ui-operations.db")).unwrap();
        conn.execute(
            "UPDATE host_revisions SET revision = 1 WHERE state_kind = 'credentials';",
            [],
        )
        .unwrap();
    }
    let lying = sha256_hex_of(b"not-the-after-bytes");
    let journal = HostOperationJournalV1 {
        schema_version: 1,
        operation_id,
        operation_kind: OperationKind::AuthLogin,
        target_label: HostStateTarget::Credentials,
        before_revision: 0,
        after_revision: 1,
        before_sha256: sha256_hex_of(&before_bytes),
        after_sha256: lying.clone(),
        before_file_sha256: sha256_hex_of(&before_bytes),
        after_file_sha256: lying,
        stage: HostJournalStage::Replaced,
        created_at_ms: FIXED_NOW_MS,
    };
    journal_prepare(&journal_dir, &journal, &before_bytes, &after_bytes).unwrap();
    assert!(matches!(
        journal_read(&journal_dir, &operation_id),
        Err(LedgerError::Corrupt(_))
    ));
    // Recovery must not treat matching live bytes as proven success when the
    // fsynced journal hashes disagree.
    assert!(matches!(
        recover_host_journal(&ledger, &journal_dir, &home, &history),
        Err(LedgerError::Corrupt(_))
    ));
    let stored = ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(
        stored.dto.status,
        praana_core::ui_contract::operation::OperationStatus::Reserved
    );
}

#[test]
fn exact_after_journal_reconstructs_auth_logout_without_probe() {
    use praana_core::ui_contract::operation::OperationStatus;
    use praana_core::ui_contract::setup::AuthState;
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let journal_dir = dir.path().join("ui-operation-journals");
    let ledger = open_host(dir.path());
    let history = HistoryService {
        now_ms: Arc::new(|| FIXED_NOW_MS),
        ..HistoryService::default()
    };
    let operation_id = new_operation_id();
    let auth = command_with_operation_id(fixture_command("auth_logout.json"), operation_id);
    futures_block_on(reserve_operation(&ledger, &auth, &history)).unwrap();
    let before_bytes = br#"{"openai":"present"}"#.to_vec();
    let after_bytes = b"{}".to_vec();
    std::fs::write(home.join("credentials.json"), &after_bytes).unwrap();
    {
        let conn = rusqlite::Connection::open(dir.path().join("ui-operations.db")).unwrap();
        conn.execute(
            "UPDATE host_revisions SET revision = 1 WHERE state_kind = 'credentials';",
            [],
        )
        .unwrap();
    }
    let journal = HostOperationJournalV1 {
        schema_version: 1,
        operation_id,
        operation_kind: OperationKind::AuthLogout,
        target_label: HostStateTarget::Credentials,
        before_revision: 0,
        after_revision: 1,
        before_sha256: sha256_hex_of(&before_bytes),
        after_sha256: sha256_hex_of(&after_bytes),
        before_file_sha256: sha256_hex_of(&before_bytes),
        after_file_sha256: sha256_hex_of(&after_bytes),
        stage: HostJournalStage::Replaced,
        created_at_ms: FIXED_NOW_MS,
    };
    journal_prepare(&journal_dir, &journal, &before_bytes, &after_bytes).unwrap();
    recover_host_journal(&ledger, &journal_dir, &home, &history).unwrap();
    let stored = ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(stored.dto.status, OperationStatus::Succeeded);
    let success: CoreCommandSuccess =
        serde_json::from_str(stored.result_json.as_deref().expect("result")).unwrap();
    match success {
        CoreCommandSuccess::AuthLogout(dto) => {
            assert_eq!(dto.provider.as_str(), "openai");
            assert_eq!(dto.state, AuthState::Unauthenticated);
            assert!(dto.fallback_model.is_none());
        }
        other => panic!("expected AuthLogout, got {other:?}"),
    }
}

#[test]
fn exact_after_journal_reconstructs_setup_and_consent_from_result_dto() {
    use praana_core::ui_contract::catalog::{ActiveModelDto, ProviderProtocol, ReasoningEffort};
    use praana_core::ui_contract::operation::OperationStatus;
    use praana_core::ui_contract::setup::{
        ConsentChoice, ConsentResolvedResultDto, SetupApplyResultDto,
    };
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let journal_dir = dir.path().join("ui-operation-journals");
    let ledger = open_host(dir.path());
    let history = HistoryService {
        now_ms: Arc::new(|| FIXED_NOW_MS),
        ..HistoryService::default()
    };

    let setup_id = new_operation_id();
    let setup = command_with_operation_id(fixture_command("setup_apply_redacted.json"), setup_id);
    futures_block_on(reserve_operation(&ledger, &setup, &history)).unwrap();
    let setup_result = SetupApplyResultDto {
        revision: 3,
        configured_provider: "openai".parse().unwrap(),
        active_model: ActiveModelDto {
            provider: "openai".parse().unwrap(),
            model_id: "gpt-5".parse().unwrap(),
            display_name: "GPT-5".to_string(),
            protocol: ProviderProtocol::OpenAiResponses,
            reasoning_effort: ReasoningEffort::Medium,
            context_window_tokens: 400000,
            boundary_canonical_sequence: None,
        },
        restart_required: false,
    };
    let before_bytes = b"{}".to_vec();
    let setup_after = serde_json::to_vec(&setup_result).unwrap();
    std::fs::write(home.join("setup-config.json"), &setup_after).unwrap();
    {
        let conn = rusqlite::Connection::open(dir.path().join("ui-operations.db")).unwrap();
        conn.execute(
            "UPDATE host_revisions SET revision = 1 WHERE state_kind = 'setup_config';",
            [],
        )
        .unwrap();
    }
    let setup_journal = HostOperationJournalV1 {
        schema_version: 1,
        operation_id: setup_id,
        operation_kind: OperationKind::SetupApply,
        target_label: HostStateTarget::SetupConfig,
        before_revision: 0,
        after_revision: 1,
        before_sha256: sha256_hex_of(&before_bytes),
        after_sha256: sha256_hex_of(&setup_after),
        before_file_sha256: sha256_hex_of(&before_bytes),
        after_file_sha256: sha256_hex_of(&setup_after),
        stage: HostJournalStage::Replaced,
        created_at_ms: FIXED_NOW_MS,
    };
    journal_prepare(&journal_dir, &setup_journal, &before_bytes, &setup_after).unwrap();

    let consent_id = new_operation_id();
    let consent = command_with_operation_id(fixture_command("consent_resolve.json"), consent_id);
    futures_block_on(reserve_operation(&ledger, &consent, &history)).unwrap();
    let consent_result = ConsentResolvedResultDto {
        consent_id: "01J8Z3NDEK000000000000000A".parse().unwrap(),
        decision: ConsentChoice::AllowOnce,
        persisted: false,
    };
    let consent_after = serde_json::to_vec(&consent_result).unwrap();
    std::fs::write(home.join("consent.json"), &consent_after).unwrap();
    {
        let conn = rusqlite::Connection::open(dir.path().join("ui-operations.db")).unwrap();
        conn.execute(
            "UPDATE host_revisions SET revision = 1 WHERE state_kind = 'consent';",
            [],
        )
        .unwrap();
    }
    let consent_journal = HostOperationJournalV1 {
        schema_version: 1,
        operation_id: consent_id,
        operation_kind: OperationKind::ConsentResolve,
        target_label: HostStateTarget::Consent,
        before_revision: 0,
        after_revision: 1,
        before_sha256: sha256_hex_of(&before_bytes),
        after_sha256: sha256_hex_of(&consent_after),
        before_file_sha256: sha256_hex_of(&before_bytes),
        after_file_sha256: sha256_hex_of(&consent_after),
        stage: HostJournalStage::Replaced,
        created_at_ms: FIXED_NOW_MS,
    };
    journal_prepare(
        &journal_dir,
        &consent_journal,
        &before_bytes,
        &consent_after,
    )
    .unwrap();

    recover_host_journal(&ledger, &journal_dir, &home, &history).unwrap();
    let stored = ledger.lookup(&setup_id).unwrap().unwrap();
    assert_eq!(stored.dto.status, OperationStatus::Succeeded);
    let success: CoreCommandSuccess =
        serde_json::from_str(stored.result_json.as_deref().expect("setup result")).unwrap();
    assert!(matches!(success, CoreCommandSuccess::SetupApplied(_)));
    let stored = ledger.lookup(&consent_id).unwrap().unwrap();
    assert_eq!(stored.dto.status, OperationStatus::Succeeded);
    let success: CoreCommandSuccess =
        serde_json::from_str(stored.result_json.as_deref().expect("consent result")).unwrap();
    match success {
        CoreCommandSuccess::ConsentResolved(dto) => {
            assert_eq!(dto.decision, ConsentChoice::AllowOnce);
            assert!(!dto.persisted);
        }
        other => panic!("expected ConsentResolved, got {other:?}"),
    }
}

#[test]
fn operation_record_dto_round_trips_with_result_refs() {
    let session_id = new_session_id();
    let operation_id = new_operation_id();
    let record = OperationRecordDto {
        operation_id,
        kind: OperationKind::TurnSubmit,
        request_sha256: Sha256Digest::from_hex_str(&"a".repeat(64)).unwrap(),
        status: praana_core::ui_contract::operation::OperationStatus::Succeeded,
        session_id: Some(session_id),
        planned_effects: vec![PlannedEffectRef::CanonicalEvents {
            session_id,
            event_ids: vec![EventId(ulid::Ulid::generate())],
        }],
        result_ref: Some(praana_core::ui_contract::operation::OperationResultRef {
            ledger: praana_core::ui_contract::operation::OperationLedgerRef::Session { session_id },
            operation_id,
            ui_contract_schema_version: 1,
            result_sha256: Sha256Digest::from_hex_str(&"b".repeat(64)).unwrap(),
        }),
        first_canonical_sequence: Some(43),
        terminal_canonical_sequence: Some(43),
        created_at_ms: FIXED_NOW_MS,
        finished_at_ms: Some(FIXED_NOW_MS + 1),
    };
    let json = serde_json::to_string(&record).unwrap();
    let again: OperationRecordDto = serde_json::from_str(&json).unwrap();
    assert_eq!(record, again);
}
