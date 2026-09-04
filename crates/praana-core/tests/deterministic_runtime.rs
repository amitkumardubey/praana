//! Deterministic runtime tests for the Phase 0 clock/ID foundation.
//!
//! All fakes are defined here (not in production source). No test uses
//! current time, OS entropy, random scheduling as an assertion input, or a
//! real sleep.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use praana_core::clock::{Clock, Sleeper, SystemClock, ThreadSleeper};
use praana_core::id::{
    IdGenerationError, IdGenerator, MonotonicUlidGenerator, ProtocolUlidId, RandomSource,
    ULID_MAX_RANDOM, ULID_MAX_TIMESTAMP_MS,
};
use ulid::Ulid;

// ── Test-only fakes ──────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
struct TestId(Ulid);

impl ProtocolUlidId for TestId {
    fn from_validated_ulid(value: Ulid) -> Self {
        TestId(value)
    }
}

impl TestId {
    fn inner(&self) -> Ulid {
        self.0
    }
}

struct FixedClock {
    now_ms: i64,
}

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.now_ms
    }
}

struct ManualClock {
    current_ms: AtomicI64,
}

impl ManualClock {
    fn new(now_ms: i64) -> Self {
        Self {
            current_ms: AtomicI64::new(now_ms),
        }
    }

    fn set(&self, now_ms: i64) {
        self.current_ms.store(now_ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.current_ms.load(Ordering::SeqCst)
    }
}

/// Sleeps without blocking and advances the manual clock per a fixed queue.
struct AdvancingSleeper {
    clock: Arc<ManualClock>,
    queue: Mutex<VecDeque<i64>>,
    sleeps: Mutex<Vec<Duration>>,
}

impl AdvancingSleeper {
    fn new(clock: Arc<ManualClock>, next_values: Vec<i64>) -> Self {
        Self {
            clock,
            queue: Mutex::new(next_values.into()),
            sleeps: Mutex::new(Vec::new()),
        }
    }

    fn recorded_sleeps(&self) -> Vec<Duration> {
        self.sleeps.lock().unwrap().clone()
    }
}

impl Sleeper for AdvancingSleeper {
    fn sleep(&self, duration: Duration) {
        self.sleeps.lock().unwrap().push(duration);
        let mut queue = self.queue.lock().unwrap();
        if let Some(next) = queue.pop_front() {
            self.clock.set(next);
        }
    }
}

/// Deterministic entropy source with a fixed queue; fails if over-consumed.
struct SequenceRandom {
    queue: Mutex<VecDeque<Result<u128, IdGenerationError>>>,
}

impl SequenceRandom {
    fn new(values: Vec<Result<u128, IdGenerationError>>) -> Self {
        Self {
            queue: Mutex::new(values.into()),
        }
    }
}

impl RandomSource for SequenceRandom {
    fn next_random_80(&mut self) -> Result<u128, IdGenerationError> {
        self.queue
            .lock()
            .unwrap()
            .pop_front()
            .expect("SequenceRandom over-consumed: scenario drew more entropy than permitted")
    }
}

/// Panics once while the generator state lock is held.
struct PanickingRandom;

impl RandomSource for PanickingRandom {
    fn next_random_80(&mut self) -> Result<u128, IdGenerationError> {
        panic!("PanickingRandom: entropy failure while the state lock is held");
    }
}

fn fixed_generator(
    now_ms: i64,
    randoms: Vec<Result<u128, IdGenerationError>>,
) -> MonotonicUlidGenerator {
    MonotonicUlidGenerator::new(
        Arc::new(FixedClock { now_ms }),
        Arc::new(NullSleeper),
        Box::new(SequenceRandom::new(randoms)),
    )
}

struct NullSleeper;

impl Sleeper for NullSleeper {
    fn sleep(&self, _duration: Duration) {}
}

// ── Required tests ───────────────────────────────────────────

#[test]
fn fixed_clock_returns_exact_epoch_ms() {
    let clock = FixedClock {
        now_ms: 1_700_000_000_123,
    };
    assert_eq!(clock.now_ms(), 1_700_000_000_123);
}

#[test]
fn first_id_uses_injected_clock_and_randomness() {
    let generator = fixed_generator(1_700_000_000_000, vec![Ok(0x0102_0304_0506_0708_090a)]);
    let id = generator.next_id::<TestId>().expect("first id");
    assert_eq!(
        id.inner(),
        Ulid::from_parts(1_700_000_000_000, 0x0102_0304_0506_0708_090a)
    );
}

#[test]
fn same_millisecond_increments_random_component_without_entropy() {
    let base_random = 0x0102_0304_0506_0708_090a;
    let generator = fixed_generator(1_700_000_000_000, vec![Ok(base_random)]);
    let first = generator.next_id::<TestId>().expect("first id");
    let second = generator.next_id::<TestId>().expect("second id");
    assert_eq!(first.inner().timestamp_ms(), 1_700_000_000_000);
    assert_eq!(second.inner().timestamp_ms(), 1_700_000_000_000);
    assert_eq!(second.inner().random(), first.inner().random() + 1);
}

#[test]
fn new_millisecond_draws_fresh_random_component() {
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let generator = MonotonicUlidGenerator::new(
        clock.clone() as Arc<dyn Clock>,
        Arc::new(NullSleeper),
        Box::new(SequenceRandom::new(vec![
            Ok(0x0102_0304_0506_0708_090a),
            Ok(0xf00d_0000_0000_0000_0000),
        ])),
    );
    let first = generator.next_id::<TestId>().expect("first id");
    clock.set(1_700_000_001_000);
    let second = generator.next_id::<TestId>().expect("second id");
    assert_eq!(first.inner().random(), 0x0102_0304_0506_0708_090a);
    assert_eq!(second.inner().timestamp_ms(), 1_700_000_001_000);
    assert_eq!(second.inner().random(), 0xf00d_0000_0000_0000_0000);
}

#[test]
fn backward_clock_keeps_last_timestamp_and_increments() {
    // First id at t; the injected clock then falls backward to t - 5.
    let sleeper_clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let generator = MonotonicUlidGenerator::new(
        Arc::new(ManualClockFollow {
            clock: sleeper_clock.clone(),
        }),
        Arc::new(NullSleeper),
        Box::new(SequenceRandom::new(vec![
            Ok(0x0102_0304_0506_0708_090a),
            Ok(0x0a0b_0c0d_0e0f_1011_1213),
        ])),
    );
    let first = generator.next_id::<TestId>().expect("first id");
    sleeper_clock.set(1_700_000_000_000 - 5);
    let second = generator.next_id::<TestId>().expect("second id");
    assert_eq!(first.inner().timestamp_ms(), 1_700_000_000_000);
    assert_eq!(second.inner().timestamp_ms(), 1_700_000_000_000);
    assert_eq!(second.inner().random(), first.inner().random() + 1);
}

struct ManualClockFollow {
    clock: Arc<ManualClock>,
}

impl Clock for ManualClockFollow {
    fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }
}

#[test]
fn random_overflow_waits_for_a_strictly_later_millisecond() {
    // First id consumes the maximum 80-bit random at time t; the next same-
    // millisecond call must wait (sleep) for a strictly later observed ms.
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let sleeper = Arc::new(AdvancingSleeper::new(
        clock.clone(),
        vec![1_700_000_000_001],
    ));
    let generator = MonotonicUlidGenerator::new(
        clock.clone() as Arc<dyn Clock>,
        sleeper.clone() as Arc<dyn Sleeper>,
        Box::new(SequenceRandom::new(vec![Ok(ULID_MAX_RANDOM), Ok(0x1234)])),
    );
    let first = generator.next_id::<TestId>().expect("first id");
    assert_eq!(first.inner().random(), ULID_MAX_RANDOM);
    let second = generator.next_id::<TestId>().expect("second id");
    assert_eq!(second.inner().timestamp_ms(), 1_700_000_000_001);
    assert_eq!(second.inner().random(), 0x1234);
    assert_eq!(sleeper.recorded_sleeps(), vec![Duration::from_millis(1)]);
}

#[test]
fn random_overflow_never_busy_spins() {
    // The clock stays behind for two retries, then advances. Each retry must
    // sleep exactly 1ms before re-reading the clock.
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let sleeper = Arc::new(AdvancingSleeper::new(
        clock.clone(),
        vec![1_700_000_000_000, 1_700_000_000_000, 1_700_000_000_007],
    ));
    let generator = MonotonicUlidGenerator::new(
        clock.clone() as Arc<dyn Clock>,
        sleeper.clone() as Arc<dyn Sleeper>,
        Box::new(SequenceRandom::new(vec![Ok(ULID_MAX_RANDOM), Ok(7)])),
    );
    let first = generator.next_id::<TestId>().expect("first id");
    assert_eq!(first.inner().random(), ULID_MAX_RANDOM);
    let second = generator.next_id::<TestId>().expect("second id");
    assert_eq!(second.inner().timestamp_ms(), 1_700_000_000_007);
    let sleeps = sleeper.recorded_sleeps();
    assert_eq!(sleeps.len(), 3);
    for duration in sleeps {
        assert_eq!(duration, Duration::from_millis(1));
    }
}

#[test]
fn maximum_timestamp_overflow_returns_timestamp_exhausted() {
    let max_ms = ULID_MAX_TIMESTAMP_MS as i64;
    let generator = fixed_generator(max_ms, vec![Ok(ULID_MAX_RANDOM)]);
    let first = generator.next_id::<TestId>().expect("first id");
    assert_eq!(first.inner().timestamp_ms(), ULID_MAX_TIMESTAMP_MS);
    let second = generator.next_id::<TestId>();
    assert!(matches!(second, Err(IdGenerationError::TimestampExhausted)));
}

#[test]
fn initial_pre_epoch_clock_is_rejected() {
    let generator = fixed_generator(-1, vec![]);
    let result = generator.next_id::<TestId>();
    assert!(matches!(
        result,
        Err(IdGenerationError::ClockBeforeUnixEpoch { observed_ms: -1 })
    ));
}

#[test]
fn initial_timestamp_above_48_bits_is_rejected() {
    const ABOVE: i64 = (ULID_MAX_TIMESTAMP_MS + 1) as i64;
    let generator = fixed_generator(ABOVE, vec![]);
    let result = generator.next_id::<TestId>();
    assert!(matches!(
        result,
        Err(IdGenerationError::ClockBeyondUlidRange { observed_ms: ABOVE })
    ));
}

#[test]
fn overflow_wait_beyond_48_bits_leaves_last_unchanged() {
    // First id consumes the maximum 80-bit random at time t. The overflow path
    // then observes a millisecond above the 48-bit ULID range and must fail
    // without mutating `last`. A later in-range observation still succeeds.
    const ABOVE: i64 = (ULID_MAX_TIMESTAMP_MS + 1) as i64;
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let sleeper = Arc::new(AdvancingSleeper::new(clock.clone(), vec![ABOVE]));
    let generator = MonotonicUlidGenerator::new(
        clock.clone() as Arc<dyn Clock>,
        sleeper.clone() as Arc<dyn Sleeper>,
        Box::new(SequenceRandom::new(vec![Ok(ULID_MAX_RANDOM), Ok(0xabcd)])),
    );
    let first = generator.next_id::<TestId>().expect("first id");
    assert_eq!(first.inner().random(), ULID_MAX_RANDOM);

    let failed = generator.next_id::<TestId>();
    assert!(matches!(
        failed,
        Err(IdGenerationError::ClockBeyondUlidRange { observed_ms: ABOVE })
    ));
    assert_eq!(sleeper.recorded_sleeps(), vec![Duration::from_millis(1)]);

    // `last` is still the first id: a new in-range millisecond draws fresh entropy.
    clock.set(1_700_000_000_002);
    let third = generator.next_id::<TestId>().expect("third id");
    assert_eq!(third.inner().timestamp_ms(), 1_700_000_000_002);
    assert_eq!(third.inner().random(), 0xabcd);
    assert_eq!(first.inner().random(), ULID_MAX_RANDOM);
}

#[test]
fn overflow_wait_entropy_failure_leaves_last_unchanged() {
    // First id consumes the maximum 80-bit random at time t. Overflow wait
    // observes t+1, then entropy fails. `last` must stay the first id.
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let sleeper = Arc::new(AdvancingSleeper::new(
        clock.clone(),
        vec![1_700_000_000_001],
    ));
    let generator = MonotonicUlidGenerator::new(
        clock.clone() as Arc<dyn Clock>,
        sleeper.clone() as Arc<dyn Sleeper>,
        Box::new(SequenceRandom::new(vec![
            Ok(ULID_MAX_RANDOM),
            Err(IdGenerationError::EntropyUnavailable),
            Ok(0x0a0b_0c0d_0e0f_1011_1213),
        ])),
    );
    let first = generator.next_id::<TestId>().expect("first id");
    assert_eq!(first.inner().random(), ULID_MAX_RANDOM);

    let failed = generator.next_id::<TestId>();
    assert!(matches!(failed, Err(IdGenerationError::EntropyUnavailable)));
    assert_eq!(sleeper.recorded_sleeps(), vec![Duration::from_millis(1)]);

    // Clock is already at t+1 from the overflow wait; a later good draw uses
    // the unused entropy slot and does not increment the exhausted random.
    let third = generator.next_id::<TestId>().expect("third id");
    assert_eq!(third.inner().timestamp_ms(), 1_700_000_000_001);
    assert_eq!(third.inner().random(), 0x0a0b_0c0d_0e0f_1011_1213);
    assert_eq!(first.inner().random(), ULID_MAX_RANDOM);
}

#[test]
fn entropy_failure_does_not_advance_state() {
    // First id at t; then the clock advances but entropy fails once; the next
    // good draw must build on the unchanged `last` state.
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let generator = MonotonicUlidGenerator::new(
        clock.clone() as Arc<dyn Clock>,
        Arc::new(NullSleeper),
        Box::new(SequenceRandom::new(vec![
            Ok(0x0102_0304_0506_0708_090a),
            Err(IdGenerationError::EntropyUnavailable),
            Ok(0x0a0b_0c0d_0e0f_1011_1213),
        ])),
    );
    let first = generator.next_id::<TestId>().expect("first id");
    clock.set(1_700_000_001_000);
    let failed = generator.next_id::<TestId>();
    assert!(matches!(failed, Err(IdGenerationError::EntropyUnavailable)));
    // The unchanged `last` is still the first id; the next good draw at the
    // strictly later millisecond uses fresh entropy, not a mutated state.
    let third = generator.next_id::<TestId>().expect("third id");
    assert_eq!(third.inner().timestamp_ms(), 1_700_000_001_000);
    assert_eq!(third.inner().random(), 0x0a0b_0c0d_0e0f_1011_1213);
    assert_eq!(first.inner().random(), 0x0102_0304_0506_0708_090a);
}

#[test]
fn out_of_range_entropy_does_not_advance_state() {
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let generator = MonotonicUlidGenerator::new(
        clock.clone() as Arc<dyn Clock>,
        Arc::new(NullSleeper),
        Box::new(SequenceRandom::new(vec![
            Ok(0x0102_0304_0506_0708_090a),
            Ok(ULID_MAX_RANDOM + 1),
            Ok(0x0a0b_0c0d_0e0f_1011_1213),
        ])),
    );
    let first = generator.next_id::<TestId>().expect("first id");
    clock.set(1_700_000_001_000);
    let failed = generator.next_id::<TestId>();
    assert!(matches!(
        failed,
        Err(IdGenerationError::EntropyOutOfRange { value }) if value == ULID_MAX_RANDOM + 1
    ));
    let third = generator.next_id::<TestId>().expect("third id");
    assert_eq!(third.inner().timestamp_ms(), 1_700_000_001_000);
    assert_eq!(third.inner().random(), 0x0a0b_0c0d_0e0f_1011_1213);
    assert_eq!(first.inner().random(), 0x0102_0304_0506_0708_090a);
}

#[test]
fn protocol_ulid_adapter_wraps_generated_value() {
    let generator = fixed_generator(1_700_000_000_000, vec![Ok(0x0102_0304_0506_0708_090a)]);
    let id = generator.next_id::<TestId>().expect("id");
    assert_eq!(
        id.inner(),
        Ulid::from_parts(1_700_000_000_000, 0x0102_0304_0506_0708_090a)
    );
}

#[test]
fn poisoned_state_returns_state_poisoned() {
    let generator = MonotonicUlidGenerator::new(
        Arc::new(FixedClock {
            now_ms: 1_700_000_000_000,
        }),
        Arc::new(NullSleeper),
        Box::new(PanickingRandom),
    );
    // The panic occurs while the state lock is held; the test observes it as
    // an unwinding first call and then requires StatePoisoned for the caller.
    let first = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        generator.next_id::<TestId>()
    }));
    assert!(first.is_err(), "PanickingRandom must abort the first call");
    let second = generator.next_id::<TestId>();
    assert!(matches!(second, Err(IdGenerationError::StatePoisoned)));
}

#[test]
fn concurrent_generation_is_unique_and_strictly_ordered() {
    const THREADS: usize = 64;
    let clock_ms = 1_700_000_000_000_i64;
    let mut randoms: Vec<Result<u128, IdGenerationError>> = (0..THREADS)
        .map(|i| Ok(0x0100_0000_0000_0000_0000 + i as u128))
        .collect();
    // The first draw seeds the generator; the remaining 63 draws serve the
    // remaining threads. The fixed clock makes every later call increment.
    randoms[0] = Ok(0x0100_0000_0000_0000_0000);
    let generator = Arc::new(fixed_generator(clock_ms, randoms));

    let mut handles = Vec::new();
    for _ in 0..THREADS {
        let generator = Arc::clone(&generator);
        handles.push(std::thread::spawn(move || {
            generator.next_id::<TestId>().expect("id")
        }));
    }
    let mut ids: Vec<TestId> = handles
        .into_iter()
        .map(|h| h.join().expect("thread"))
        .collect();
    ids.sort_by_key(|id| id.inner());

    let mut previous: Option<Ulid> = None;
    for id in &ids {
        assert_eq!(id.inner().timestamp_ms(), clock_ms as u64);
        if let Some(prev) = previous {
            assert_eq!(
                id.inner().random(),
                prev.random() + 1,
                "contiguous increments"
            );
        }
        previous = Some(id.inner());
    }
    let distinct: std::collections::HashSet<Ulid> = ids.iter().map(|id| id.inner()).collect();
    assert_eq!(distinct.len(), THREADS);
}

#[test]
fn system_clock_is_callable_without_panicking() {
    let now = SystemClock.now_ms();
    // No wall-clock assertion and no real sleep; only callability.
    let _ = now;
    let _sleeper = ThreadSleeper;
}

#[test]
fn system_generator_returns_valid_strictly_increasing_ulids() {
    let generator = MonotonicUlidGenerator::system();
    let first = generator.next_id::<TestId>().expect("first id");
    let second = generator.next_id::<TestId>().expect("second id");
    let a = first.inner();
    let b = second.inner();
    assert!(b > a, "system generator must be strictly increasing");
}
