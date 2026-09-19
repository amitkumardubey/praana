//! Bounded UI event sink with priority, coalescing, and detach semantics.
//!
//! `ChannelUiSink` holds exactly 1,024 queued records and 8 MiB estimated
//! payload capacity. Latest-only and appendable emission never waits; critical
//! emission may await capacity for at most 2,000 ms before the sink detaches.
//! Sink failure never rolls back or mutates canonical state.

use async_trait::async_trait;
use std::collections::VecDeque;
use std::time::Duration;
use tokio::sync::{Mutex, Notify};

use crate::ui_contract::event::{coalesce_key, priority, UiCoalesceKey, UiEventPriority};
use crate::ui_contract::{validate_ui_event, UiContractError, UiEventRecord};

pub const SINK_QUEUE_RECORDS: usize = 1_024;
pub const SINK_QUEUE_BYTES: u64 = 8 * 1024 * 1024;
pub const CRITICAL_WAIT_TIMEOUT: Duration = Duration::from_millis(2_000);
pub const APPEND_MERGE_MAX_BYTES: usize = 16_384;

#[async_trait]
pub trait UiEventSink: Send + Sync + 'static {
    async fn emit(&self, event: UiEventRecord) -> Result<(), UiSinkError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UiSinkError {
    Detached,
    CriticalDeadlineExceeded,
    InvalidEvent(String),
}

impl std::fmt::Display for UiSinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UiSinkError::Detached => write!(f, "UI event sink detached"),
            UiSinkError::CriticalDeadlineExceeded => {
                write!(f, "critical event deadline exceeded")
            }
            UiSinkError::InvalidEvent(msg) => write!(f, "invalid UI event: {msg}"),
        }
    }
}

impl std::error::Error for UiSinkError {}

impl From<UiContractError> for UiSinkError {
    fn from(error: UiContractError) -> Self {
        UiSinkError::InvalidEvent(error.to_string())
    }
}

struct QueuedRecord {
    record: UiEventRecord,
    bytes: usize,
}

struct SinkState {
    queue: VecDeque<QueuedRecord>,
    queued_bytes: u64,
    detached: bool,
    receiver_closed: bool,
    coalesced: u64,
    dropped_ephemeral: u64,
}

/// Bounded in-process channel sink. One instance serializes emission through
/// its internal mutex: concurrent producers cannot reorder records.
pub struct ChannelUiSink {
    state: Mutex<SinkState>,
    capacity_notify: Notify,
    consumer_notify: Notify,
}

/// Outcome of a latest-only replacement attempt.
enum ReplaceOutcome {
    /// The older queued record now carries the newer payload.
    Replaced,
    /// No queued record carries the key; the caller keeps the record.
    Miss(Box<UiEventRecord>),
    /// The replacement would exceed the payload bound: the old record is
    /// kept and the new payload is dropped (already counted).
    OverBound,
}

impl ChannelUiSink {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(SinkState {
                queue: VecDeque::new(),
                queued_bytes: 0,
                detached: false,
                receiver_closed: false,
                coalesced: 0,
                dropped_ephemeral: 0,
            }),
            capacity_notify: Notify::new(),
            consumer_notify: Notify::new(),
        }
    }

    /// Current queue depth and estimated bytes (for tests and backpressure
    /// reporting).
    pub async fn queue_stats(&self) -> (usize, u64) {
        let state = self.state.lock().await;
        (state.queue.len(), state.queued_bytes)
    }

    pub async fn is_detached(&self) -> bool {
        self.state.lock().await.detached
    }

    pub async fn counters(&self) -> (u64, u64) {
        let state = self.state.lock().await;
        (state.coalesced, state.dropped_ephemeral)
    }

    /// Receive the next queued record. Returns `None` once the sink detaches
    /// (receiver closure is the persistent fatal signal) or after explicit
    /// close with an empty queue.
    pub async fn recv(&self) -> Option<UiEventRecord> {
        loop {
            {
                let mut state = self.state.lock().await;
                if state.detached || state.receiver_closed {
                    return None;
                }
                if let Some(queued) = state.queue.pop_front() {
                    state.queued_bytes -= queued.bytes as u64;
                    drop(state);
                    self.capacity_notify.notify_waiters();
                    return Some(queued.record);
                }
            }
            self.consumer_notify.notified().await;
        }
    }

    /// Try to receive without waiting.
    pub async fn try_recv(&self) -> Option<UiEventRecord> {
        let mut state = self.state.lock().await;
        if state.detached || state.receiver_closed {
            return None;
        }
        let queued = state.queue.pop_front()?;
        state.queued_bytes -= queued.bytes as u64;
        drop(state);
        self.capacity_notify.notify_waiters();
        Some(queued.record)
    }

    fn estimate_bytes(record: &UiEventRecord) -> Result<usize, UiSinkError> {
        serde_json::to_vec(record)
            .map(|v| v.len())
            .map_err(|e| UiSinkError::InvalidEvent(format!("unserializable event: {e}")))
    }

    fn fits(state: &SinkState, bytes: usize) -> bool {
        state.queue.len() < SINK_QUEUE_RECORDS
            && state.queued_bytes + bytes as u64 <= SINK_QUEUE_BYTES
    }

    /// Replace the older queued record for a latest-only key in place,
    /// carrying the newer payload at the older position.
    fn replace_latest(
        state: &mut SinkState,
        key: &UiCoalesceKey,
        record: UiEventRecord,
        bytes: usize,
    ) -> ReplaceOutcome {
        let position = state.queue.iter().position(|queued| {
            let qr = UiEventRecord {
                ui_contract_schema_version: queued.record.ui_contract_schema_version,
                session_id: queued.record.session_id,
                turn_id: queued.record.turn_id,
                attempt_id: queued.record.attempt_id,
                operation_id: queued.record.operation_id,
                durability: queued.record.durability.clone(),
                event: queued.record.event.clone(),
            };
            coalesce_key(&qr).as_ref() == Some(key)
        });
        if let Some(index) = position {
            let old = state.queue.remove(index).expect("position checked");
            state.queued_bytes -= old.bytes as u64;
            if state.queue.len() + 1 > SINK_QUEUE_RECORDS
                || state.queued_bytes + bytes as u64 > SINK_QUEUE_BYTES
            {
                // No legal bounded slot: keep the old record, drop the new
                // latest-only payload without waiting.
                state.queued_bytes += old.bytes as u64;
                state.queue.insert(index, old);
                state.dropped_ephemeral += 1;
                return ReplaceOutcome::OverBound;
            }
            state.queued_bytes += bytes as u64;
            state.queue.insert(index, QueuedRecord { record, bytes });
            state.coalesced += 1;
            ReplaceOutcome::Replaced
        } else {
            ReplaceOutcome::Miss(Box::new(record))
        }
    }

    /// Merge an appendable delta into the last queued record with the same
    /// key when ranges are adjacent, the merged text stays within 16,384
    /// bytes, and the merged payload stays within the 8 MiB queue bound.
    /// Returns true when merged; a refused merge leaves the older record
    /// untouched.
    fn merge_appendable(state: &mut SinkState, record: &UiEventRecord) -> bool {
        let UiEventRecord { event, .. } = record;
        let crate::ui_contract::UiEvent::AssistantDelta(delta) = event else {
            return false;
        };
        let key = match coalesce_key(record) {
            Some(key) => key,
            None => return false,
        };
        let index = state.queue.iter().rposition(|queued| {
            let qr = UiEventRecord {
                ui_contract_schema_version: queued.record.ui_contract_schema_version,
                session_id: queued.record.session_id,
                turn_id: queued.record.turn_id,
                attempt_id: queued.record.attempt_id,
                operation_id: queued.record.operation_id,
                durability: queued.record.durability.clone(),
                event: queued.record.event.clone(),
            };
            coalesce_key(&qr).as_ref() == Some(&key)
        });
        let Some(index) = index else { return false };
        let queued = &mut state.queue[index];
        let crate::ui_contract::UiEvent::AssistantDelta(existing) = &mut queued.record.event else {
            return false;
        };
        if existing.block_kind != delta.block_kind {
            return false;
        }
        if existing.last_chunk_index + 1 != delta.first_chunk_index {
            return false;
        }
        let merged_len = existing.text.len() + delta.text.len();
        if merged_len > APPEND_MERGE_MAX_BYTES {
            return false;
        }
        // Prospectively merge on a clone so the queue bound is checked before
        // the older record is touched.
        let mut candidate = queued.record.clone();
        let crate::ui_contract::UiEvent::AssistantDelta(candidate_delta) = &mut candidate.event
        else {
            return false;
        };
        candidate_delta.text.push_str(&delta.text);
        candidate_delta.last_chunk_index = delta.last_chunk_index;
        let Ok(bytes) = serde_json::to_vec(&candidate).map(|v| v.len()) else {
            return false;
        };
        if state.queued_bytes - queued.bytes as u64 + bytes as u64 > SINK_QUEUE_BYTES {
            return false;
        }
        let old_bytes = queued.bytes;
        queued.record = candidate;
        queued.bytes = bytes;
        state.queued_bytes = state.queued_bytes - old_bytes as u64 + bytes as u64;
        state.coalesced += 1;
        true
    }

    /// Evict the oldest queued latest-only or appendable record to make room.
    /// Critical records are never evicted. Eviction counts as a drop, not a
    /// coalescing merge.
    fn evict_older_non_critical(state: &mut SinkState) -> bool {
        let position = state.queue.iter().position(|queued| {
            !matches!(priority(&queued.record.event), UiEventPriority::Critical)
        });
        if let Some(index) = position {
            let old = state.queue.remove(index).expect("position checked");
            state.queued_bytes -= old.bytes as u64;
            state.dropped_ephemeral += 1;
            true
        } else {
            false
        }
    }

    async fn detach_locked(state: &mut SinkState) {
        state.detached = true;
        state.receiver_closed = true;
    }
}

impl Default for ChannelUiSink {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl UiEventSink for ChannelUiSink {
    async fn emit(&self, event: UiEventRecord) -> Result<(), UiSinkError> {
        validate_ui_event(&event)?;
        let bytes = Self::estimate_bytes(&event)?;
        match priority(&event.event) {
            UiEventPriority::Critical => {
                // Critical events never coalesce or drop. Await a bounded
                // slot for at most 2,000 ms after canonical durability. The
                // capacity re-check and the push hold the same mutex, so two
                // concurrent waiters cannot both claim one free slot.
                let wait = async {
                    loop {
                        {
                            let mut state = self.state.lock().await;
                            if state.detached {
                                return Err(UiSinkError::Detached);
                            }
                            if Self::fits(&state, bytes) {
                                state.queued_bytes += bytes as u64;
                                state.queue.push_back(QueuedRecord {
                                    record: event,
                                    bytes,
                                });
                                return Ok(());
                            }
                        }
                        self.capacity_notify.notified().await;
                    }
                };
                let admitted = match tokio::time::timeout(CRITICAL_WAIT_TIMEOUT, wait).await {
                    Ok(Ok(())) => true,
                    Ok(Err(e)) => return Err(e),
                    Err(_) => false,
                };
                if !admitted {
                    let mut state = self.state.lock().await;
                    if !state.detached {
                        Self::detach_locked(&mut state).await;
                    }
                    self.consumer_notify.notify_waiters();
                    self.capacity_notify.notify_waiters();
                    return Err(UiSinkError::CriticalDeadlineExceeded);
                }
                self.consumer_notify.notify_one();
                Ok(())
            }
            UiEventPriority::LatestOnly => {
                let mut state = self.state.lock().await;
                if state.detached {
                    return Err(UiSinkError::Detached);
                }
                let mut event = event;
                let key = coalesce_key(&event);
                if let Some(ref key) = key {
                    match Self::replace_latest(&mut state, key, event, bytes) {
                        ReplaceOutcome::Replaced => {
                            drop(state);
                            self.consumer_notify.notify_one();
                            return Ok(());
                        }
                        ReplaceOutcome::OverBound => {
                            return Ok(());
                        }
                        ReplaceOutcome::Miss(record) => {
                            event = *record;
                        }
                    }
                }
                // A single record larger than the whole payload budget can
                // never fit: drop it without evicting queued records.
                if bytes as u64 > SINK_QUEUE_BYTES {
                    state.dropped_ephemeral += 1;
                    return Ok(());
                }
                if Self::fits(&state, bytes) {
                    state.queued_bytes += bytes as u64;
                    state.queue.push_back(QueuedRecord {
                        record: event,
                        bytes,
                    });
                    drop(state);
                    self.consumer_notify.notify_one();
                    return Ok(());
                }
                // No legal bounded slot: evict an older non-critical record
                // first; never drop or delay a critical record. If the queue
                // holds only critical records, drop the incoming record.
                if key.is_some()
                    && Self::evict_older_non_critical(&mut state)
                    && Self::fits(&state, bytes)
                {
                    state.queued_bytes += bytes as u64;
                    state.queue.push_back(QueuedRecord {
                        record: event,
                        bytes,
                    });
                    drop(state);
                    self.consumer_notify.notify_one();
                    return Ok(());
                }
                state.dropped_ephemeral += 1;
                Ok(())
            }
            UiEventPriority::Appendable => {
                let mut state = self.state.lock().await;
                if state.detached {
                    return Err(UiSinkError::Detached);
                }
                if Self::merge_appendable(&mut state, &event) {
                    self.consumer_notify.notify_one();
                    return Ok(());
                }
                // A single record larger than the whole payload budget can
                // never fit: drop it without evicting queued records.
                if bytes as u64 > SINK_QUEUE_BYTES {
                    state.dropped_ephemeral += 1;
                    return Ok(());
                }
                if Self::fits(&state, bytes) {
                    state.queued_bytes += bytes as u64;
                    state.queue.push_back(QueuedRecord {
                        record: event,
                        bytes,
                    });
                    drop(state);
                    self.consumer_notify.notify_one();
                    return Ok(());
                }
                // Appendable deltas may be dropped under pressure because
                // AssistantAccepted is complete reconciliation authority.
                state.dropped_ephemeral += 1;
                Ok(())
            }
        }
    }
}

/// Explicit terminal consumer for headless mode: accepts every record
/// immediately and retains none. This is not a bounded-queue drop.
pub struct NullUiSink;

#[async_trait]
impl UiEventSink for NullUiSink {
    async fn emit(&self, event: UiEventRecord) -> Result<(), UiSinkError> {
        validate_ui_event(&event)?;
        Ok(())
    }
}

/// Backpressure counters for the `runtime_backpressure` event payload.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SinkBackpressureCounters {
    pub coalesced: u64,
    pub dropped_ephemeral: u64,
    pub queue_events: u32,
    pub queue_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacities_match_spec() {
        assert_eq!(SINK_QUEUE_RECORDS, 1_024);
        assert_eq!(SINK_QUEUE_BYTES, 8 * 1024 * 1024);
        assert_eq!(CRITICAL_WAIT_TIMEOUT, Duration::from_millis(2_000));
        assert_eq!(APPEND_MERGE_MAX_BYTES, 16_384);
    }
}
