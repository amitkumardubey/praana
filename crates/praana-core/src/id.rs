//! Monotonic ULID ID generation foundation.
//!
//! One generator instance serializes all allocations behind a single mutex and
//! guarantees one strictly increasing sequence. Callers inject the clock, the
//! sleeper, and the 80-bit entropy source; nothing here reads wall time or OS
//! randomness outside [`SystemClock`] and [`OsRandomSource`].

use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ulid::Ulid;

use crate::clock::{Clock, Sleeper, SystemClock, ThreadSleeper};

pub const ULID_MAX_TIMESTAMP_MS: u64 = (1_u64 << 48) - 1;
pub const ULID_MAX_RANDOM: u128 = (1_u128 << 80) - 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdGenerationError {
    ClockBeforeUnixEpoch { observed_ms: i64 },
    ClockBeyondUlidRange { observed_ms: i64 },
    EntropyUnavailable,
    EntropyOutOfRange { value: u128 },
    TimestampExhausted,
    StatePoisoned,
}

impl fmt::Display for IdGenerationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IdGenerationError::ClockBeforeUnixEpoch { observed_ms } => {
                write!(f, "clock before Unix epoch: observed {observed_ms} ms")
            }
            IdGenerationError::ClockBeyondUlidRange { observed_ms } => {
                write!(
                    f,
                    "clock beyond the 48-bit ULID timestamp range: observed {observed_ms} ms"
                )
            }
            IdGenerationError::EntropyUnavailable => {
                write!(f, "OS entropy source is unavailable")
            }
            IdGenerationError::EntropyOutOfRange { value } => {
                write!(f, "entropy source produced an out-of-range value: {value}")
            }
            IdGenerationError::TimestampExhausted => {
                write!(f, "ULID timestamp space is exhausted")
            }
            IdGenerationError::StatePoisoned => {
                write!(f, "generator state is poisoned by a prior panic")
            }
        }
    }
}

impl std::error::Error for IdGenerationError {}

pub trait RandomSource: Send {
    fn next_random_80(&mut self) -> Result<u128, IdGenerationError>;
}

#[derive(Debug, Default)]
pub struct OsRandomSource;

impl RandomSource for OsRandomSource {
    fn next_random_80(&mut self) -> Result<u128, IdGenerationError> {
        let mut bytes = [0u8; 10];
        getrandom::fill(&mut bytes).map_err(|_| IdGenerationError::EntropyUnavailable)?;
        Ok(u128::from_be_bytes([
            0, 0, 0, 0, 0, 0, bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6],
            bytes[7], bytes[8], bytes[9],
        ]))
    }
}

/// The only Phase 0 adapter for later protocol-owned ULID newtypes.
pub trait ProtocolUlidId: Sized {
    fn from_validated_ulid(value: Ulid) -> Self;
}

pub trait IdGenerator: Send + Sync {
    fn next_id<T: ProtocolUlidId>(&self) -> Result<T, IdGenerationError>;
}

struct GeneratorState {
    last: Option<Ulid>,
    random: Box<dyn RandomSource>,
}

pub struct MonotonicUlidGenerator {
    clock: Arc<dyn Clock>,
    sleeper: Arc<dyn Sleeper>,
    state: Mutex<GeneratorState>,
}

impl MonotonicUlidGenerator {
    pub fn new(
        clock: Arc<dyn Clock>,
        sleeper: Arc<dyn Sleeper>,
        random: Box<dyn RandomSource>,
    ) -> Self {
        Self {
            clock,
            sleeper,
            state: Mutex::new(GeneratorState { last: None, random }),
        }
    }

    pub fn system() -> Self {
        Self::new(
            Arc::new(SystemClock),
            Arc::new(ThreadSleeper),
            Box::new(OsRandomSource),
        )
    }
}

impl Default for MonotonicUlidGenerator {
    fn default() -> Self {
        Self::system()
    }
}

impl IdGenerator for MonotonicUlidGenerator {
    fn next_id<T: ProtocolUlidId>(&self) -> Result<T, IdGenerationError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| IdGenerationError::StatePoisoned)?;
        allocate(&mut state, self.clock.as_ref(), self.sleeper.as_ref()).map(T::from_validated_ulid)
    }
}

fn draw_random(state: &mut GeneratorState) -> Result<u128, IdGenerationError> {
    let value = state.random.next_random_80()?;
    if value > ULID_MAX_RANDOM {
        return Err(IdGenerationError::EntropyOutOfRange { value });
    }
    Ok(value)
}

fn validate_timestamp(observed_ms: i64) -> Result<u64, IdGenerationError> {
    if observed_ms < 0 {
        return Err(IdGenerationError::ClockBeforeUnixEpoch { observed_ms });
    }
    if observed_ms as u64 > ULID_MAX_TIMESTAMP_MS {
        return Err(IdGenerationError::ClockBeyondUlidRange { observed_ms });
    }
    Ok(observed_ms as u64)
}

/// Runs the exact Section 8.3 state transition while the state lock is held.
fn allocate(
    state: &mut GeneratorState,
    clock: &dyn Clock,
    sleeper: &dyn Sleeper,
) -> Result<Ulid, IdGenerationError> {
    let observed = clock.now_ms();
    let Some(last) = state.last else {
        let timestamp = validate_timestamp(observed)?;
        let random = draw_random(state)?;
        let id = Ulid::from_parts(timestamp, random);
        state.last = Some(id);
        return Ok(id);
    };

    if observed > last.timestamp_ms() as i64 {
        let timestamp = validate_timestamp(observed)?;
        let random = draw_random(state)?;
        let id = Ulid::from_parts(timestamp, random);
        state.last = Some(id);
        return Ok(id);
    }

    // Equal or backward clock: keep the retained timestamp and increment the
    // random component. No entropy is drawn.
    if last.random() < ULID_MAX_RANDOM {
        let id = Ulid::from_parts(last.timestamp_ms(), last.random() + 1);
        state.last = Some(id);
        return Ok(id);
    }

    if last.timestamp_ms() == ULID_MAX_TIMESTAMP_MS {
        return Err(IdGenerationError::TimestampExhausted);
    }

    // Random overflow: wait for a strictly later observed millisecond. The
    // loop sleeps before every retry and never busy-spins. A value above the
    // 48-bit range fails without changing `last`.
    let retained = last.timestamp_ms();
    loop {
        sleeper.sleep(Duration::from_millis(1));
        let observed = clock.now_ms();
        if observed <= retained as i64 {
            continue;
        }
        let timestamp = validate_timestamp(observed)?;
        let random = draw_random(state)?;
        let id = Ulid::from_parts(timestamp, random);
        state.last = Some(id);
        return Ok(id);
    }
}
