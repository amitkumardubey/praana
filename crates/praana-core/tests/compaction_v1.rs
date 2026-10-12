//! Compaction spec §18.1 and §18.2: pressure and complete-turn selection.
//! P5-1 covers the pure parts only. No turn loop, provider, or History wiring.

use praana_core::compaction::admission::{
    next_pressure_state, ratio_to_ppm, should_launch, PressureState, PressureThresholds,
};
use praana_core::compaction::selection::{select_turns, ProjectedTurn, Selection};
use praana_core::compaction::CompactionError;
use praana_core::protocol::id::TurnId;
use proptest::prelude::*;
use ulid::Ulid;

fn tid(n: u64) -> TurnId {
    TurnId(Ulid::from_parts(1, u128::from(n)))
}

/// A closed, protocol-complete, retained turn in epoch 0.
fn turn(n: u64, tokens: u64) -> ProjectedTurn {
    ProjectedTurn {
        turn_id: tid(n),
        start_sequence: n * 10,
        closure_sequence: n * 10 + 9,
        reset_epoch: 0,
        retired_by_epoch: None,
        compaction_closed: true,
        protocol_complete: true,
        accepted_message_tokens: tokens,
    }
}

fn ids(selection: &Selection) -> Vec<TurnId> {
    selection.turn_ids.clone()
}

const HALF: u32 = 500_000;

// ---------------------------------------------------------------- pressure

fn defaults() -> PressureThresholds {
    PressureThresholds::from_ratios(0.60, 0.45).unwrap()
}

#[test]
fn ratio_to_ppm_converts_config_defaults_exactly() {
    assert_eq!(ratio_to_ppm(0.60).unwrap(), 600_000);
    assert_eq!(ratio_to_ppm(0.45).unwrap(), 450_000);
    assert_eq!(ratio_to_ppm(0.50).unwrap(), 500_000);
    assert_eq!(ratio_to_ppm(1.0).unwrap(), 1_000_000);
    assert_eq!(ratio_to_ppm(0.05).unwrap(), 50_000);
}

#[test]
fn ratio_to_ppm_rejects_non_finite_and_out_of_range() {
    assert!(ratio_to_ppm(f64::NAN).is_err());
    assert!(ratio_to_ppm(f64::INFINITY).is_err());
    assert!(ratio_to_ppm(-0.1).is_err());
    assert!(ratio_to_ppm(1.000_001).is_err());
}

#[test]
fn thresholds_require_clear_strictly_below_trigger() {
    assert!(PressureThresholds::from_ratios(0.45, 0.45).is_err());
    assert!(PressureThresholds::from_ratios(0.40, 0.45).is_err());
    assert!(PressureThresholds::from_ratios(0.60, 0.45).is_ok());
}

#[test]
fn normal_state_enters_high_at_trigger_not_below() {
    let t = defaults();
    assert_eq!(
        next_pressure_state(PressureState::Normal, 599_999, t),
        PressureState::Normal
    );
    assert_eq!(
        next_pressure_state(PressureState::Normal, 600_000, t),
        PressureState::High
    );
    assert_eq!(
        next_pressure_state(PressureState::Normal, 600_001, t),
        PressureState::High
    );
    assert_eq!(
        next_pressure_state(PressureState::Normal, 1_000_000, t),
        PressureState::High
    );
}

#[test]
fn high_state_clears_at_clear_not_above() {
    let t = defaults();
    assert_eq!(
        next_pressure_state(PressureState::High, 450_001, t),
        PressureState::High
    );
    assert_eq!(
        next_pressure_state(PressureState::High, 450_000, t),
        PressureState::Normal
    );
    assert_eq!(
        next_pressure_state(PressureState::High, 449_999, t),
        PressureState::Normal
    );
}

#[test]
fn state_holds_between_clear_and_trigger() {
    let t = defaults();
    for fill in [450_001, 500_000, 599_999] {
        assert_eq!(
            next_pressure_state(PressureState::Normal, fill, t),
            PressureState::Normal
        );
        assert_eq!(
            next_pressure_state(PressureState::High, fill, t),
            PressureState::High
        );
    }
}

#[test]
fn high_is_a_signal_not_a_lockout() {
    let t = defaults();
    // Stay High while fill grows again; launch is decided by fill, not state.
    let mut state = PressureState::Normal;
    for fill in [600_000, 520_000, 640_000] {
        state = next_pressure_state(state, fill, t);
        assert_eq!(state, PressureState::High);
    }
    assert!(should_launch(520_000 + 100_000, t, false, true));
}

#[test]
fn launch_needs_trigger_idle_compactor_and_new_eligible_turn() {
    let t = defaults();
    assert!(should_launch(600_000, t, false, true));
    assert!(!should_launch(599_999, t, false, true));
    assert!(!should_launch(600_000, t, true, true), "already in flight");
    assert!(
        !should_launch(600_000, t, false, false),
        "no eligible turn beyond the last attempt at this projection sequence"
    );
}

// --------------------------------------------------------------- selection

#[test]
fn pressure_selects_oldest_closed_prefix() {
    // Eligible mass 400, 50% target 200: 100 + 100 reaches it; turn 3 stays.
    let turns = vec![turn(1, 100), turn(2, 100), turn(3, 100), turn(4, 100)];
    let s = select_turns(&turns, None, 0, HALF).unwrap();
    assert_eq!(ids(&s), vec![tid(1), tid(2)]);
    assert_eq!(s.eligible_mass, 400);
    assert_eq!(s.target_mass, 200);
    assert_eq!(s.selected_mass, 200);
    assert_eq!(s.source_start_sequence, 10);
    assert_eq!(s.source_end_sequence, 29);
}

#[test]
fn target_rounds_up_to_the_next_token() {
    // 3 tokens * 50% = 1.5 -> 2.
    let turns = vec![turn(1, 1), turn(2, 1), turn(3, 1)];
    let s = select_turns(&turns, None, 0, HALF).unwrap();
    assert_eq!(s.target_mass, 2);
    assert_eq!(ids(&s), vec![tid(1), tid(2)]);
}

#[test]
fn target_is_at_least_one_token() {
    let turns = vec![turn(1, 1)];
    let s = select_turns(&turns, None, 0, 50_000).unwrap();
    assert_eq!(s.target_mass, 1);
    assert_eq!(ids(&s), vec![tid(1)]);
}

#[test]
fn one_oversized_turn_is_selected_whole() {
    let turns = vec![turn(1, 10_000), turn(2, 10)];
    let s = select_turns(&turns, None, 0, HALF).unwrap();
    assert_eq!(ids(&s), vec![tid(1)]);
    assert_eq!(s.selected_mass, 10_000);
    assert!(s.selected_mass > s.target_mass);
}

#[test]
fn full_fraction_selects_the_whole_eligible_prefix() {
    let turns = vec![turn(1, 7), turn(2, 9), turn(3, 11)];
    let s = select_turns(&turns, None, 0, 1_000_000).unwrap();
    assert_eq!(ids(&s), vec![tid(1), tid(2), tid(3)]);
    assert_eq!(s.selected_mass, s.eligible_mass);
}

#[test]
fn active_turn_is_a_barrier() {
    let turns = vec![turn(1, 100), turn(2, 100), turn(3, 100)];
    let s = select_turns(&turns, Some(tid(2)), 0, 1_000_000).unwrap();
    assert_eq!(ids(&s), vec![tid(1)]);
    assert_eq!(s.eligible_mass, 100);
}

#[test]
fn active_turn_first_leaves_nothing_to_retire() {
    let turns = vec![turn(1, 100)];
    assert_eq!(
        select_turns(&turns, Some(tid(1)), 0, HALF),
        Err(CompactionError::NoEligibleTurns)
    );
}

#[test]
fn single_turn_session_has_no_eligible_turns() {
    // `praana run`: the only turn is the active one (spec §5.3).
    let turns = vec![turn(1, 5_000)];
    let err = select_turns(&turns, Some(tid(1)), 0, HALF).unwrap_err();
    assert_eq!(err, CompactionError::NoEligibleTurns);
    assert_eq!(err.code(), "COMPACTION_NO_ELIGIBLE_TURNS");
}

#[test]
fn empty_history_has_no_eligible_turns() {
    assert_eq!(
        select_turns(&[], None, 0, HALF),
        Err(CompactionError::NoEligibleTurns)
    );
}

#[test]
fn interrupted_capsule_closes_but_open_turn_is_a_barrier() {
    // A validated capsule is closed (compaction_closed = true) and selectable.
    let mut capsule = turn(2, 100);
    capsule.compaction_closed = true;
    let mut open = turn(3, 100);
    open.compaction_closed = false;
    let turns = vec![turn(1, 100), capsule, open, turn(4, 100)];
    let s = select_turns(&turns, None, 0, 1_000_000).unwrap();
    assert_eq!(ids(&s), vec![tid(1), tid(2)], "turn 4 is behind a barrier");
}

#[test]
fn protocol_incomplete_turn_is_a_barrier() {
    let mut bad = turn(2, 100);
    bad.protocol_complete = false;
    let turns = vec![turn(1, 100), bad, turn(3, 100)];
    let s = select_turns(&turns, None, 0, 1_000_000).unwrap();
    assert_eq!(ids(&s), vec![tid(1)]);
}

#[test]
fn barrier_first_yields_no_eligible_turns() {
    let mut bad = turn(1, 100);
    bad.compaction_closed = false;
    let turns = vec![bad, turn(2, 100)];
    assert_eq!(
        select_turns(&turns, None, 0, HALF),
        Err(CompactionError::NoEligibleTurns)
    );
}

#[test]
fn already_retired_turns_are_skipped_not_barriers() {
    let mut retired = turn(1, 100);
    retired.retired_by_epoch = Some(1);
    let turns = vec![retired, turn(2, 100), turn(3, 100)];
    let s = select_turns(&turns, None, 0, 1_000_000).unwrap();
    assert_eq!(ids(&s), vec![tid(2), tid(3)]);
    assert_eq!(s.source_start_sequence, 20);
}

#[test]
fn reset_epoch_split_never_mixes_epochs() {
    let mut old = turn(1, 100);
    old.reset_epoch = 0;
    let mut new_a = turn(2, 100);
    new_a.reset_epoch = 1;
    let mut new_b = turn(3, 100);
    new_b.reset_epoch = 1;
    let turns = vec![old, new_a, new_b];

    let current = select_turns(&turns, None, 1, 1_000_000).unwrap();
    assert_eq!(ids(&current), vec![tid(2), tid(3)]);

    let stale = select_turns(&turns, None, 0, 1_000_000).unwrap();
    assert_eq!(ids(&stale), vec![tid(1)]);
}

#[test]
fn zero_token_mass_is_an_error() {
    let turns = vec![turn(1, 100), turn(2, 0)];
    let err = select_turns(&turns, None, 0, HALF).unwrap_err();
    assert_eq!(err, CompactionError::MissingTokenMass(tid(2)));
    assert_eq!(err.code(), "COMPACTION_MISSING_TOKEN_MASS");
}

#[test]
fn mass_overflow_is_checked() {
    let turns = vec![turn(1, u64::MAX), turn(2, 1)];
    let err = select_turns(&turns, None, 0, HALF).unwrap_err();
    assert_eq!(err, CompactionError::ArithmeticOverflow);
    assert_eq!(err.code(), "ADMISSION_ARITHMETIC_OVERFLOW");
}

#[test]
fn scaling_overflow_is_checked() {
    // mass * fraction_ppm overflows u64 even though the sum fits.
    let turns = vec![turn(1, u64::MAX / 2)];
    assert_eq!(
        select_turns(&turns, None, 0, 1_000_000),
        Err(CompactionError::ArithmeticOverflow)
    );
}

#[test]
fn input_order_and_timestamps_do_not_matter() {
    let ordered = vec![turn(1, 30), turn(2, 40), turn(3, 50), turn(4, 60)];
    let expected = select_turns(&ordered, None, 0, HALF).unwrap();
    let mut shuffled = vec![
        ordered[2].clone(),
        ordered[0].clone(),
        ordered[3].clone(),
        ordered[1].clone(),
    ];
    assert_eq!(select_turns(&shuffled, None, 0, HALF).unwrap(), expected);
    shuffled.reverse();
    assert_eq!(select_turns(&shuffled, None, 0, HALF).unwrap(), expected);
}

// ------------------------------------------------------------ properties

#[derive(Clone, Debug)]
struct Spec {
    tokens: u64,
    closed: bool,
    complete: bool,
    retired: bool,
    epoch: u32,
}

fn spec_strategy() -> impl Strategy<Value = Spec> {
    (
        1u64..=5_000,
        prop::bool::weighted(0.85),
        prop::bool::weighted(0.9),
        prop::bool::weighted(0.1),
        0u32..=2,
    )
        .prop_map(|(tokens, closed, complete, retired, epoch)| Spec {
            tokens,
            closed,
            complete,
            retired,
            epoch,
        })
}

fn build(specs: &[Spec]) -> Vec<ProjectedTurn> {
    specs
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let mut t = turn(i as u64 + 1, s.tokens);
            t.compaction_closed = s.closed;
            t.protocol_complete = s.complete;
            t.retired_by_epoch = s.retired.then_some(1);
            t.reset_epoch = s.epoch;
            t
        })
        .collect()
}

/// Reference model of §5.1/§6: the eligible prefix for `epoch`.
fn eligible_prefix(
    turns: &[ProjectedTurn],
    active: Option<TurnId>,
    epoch: u32,
) -> Vec<&ProjectedTurn> {
    let mut out = Vec::new();
    for t in turns {
        if t.reset_epoch != epoch {
            continue;
        }
        if active == Some(t.turn_id) {
            break;
        }
        if t.retired_by_epoch.is_some() {
            continue;
        }
        if !t.compaction_closed || !t.protocol_complete {
            break;
        }
        out.push(t);
    }
    out
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn selection_properties(
        specs in prop::collection::vec(spec_strategy(), 0..24),
        active_pick in prop::option::of(0usize..24),
        epoch in 0u32..=2,
        fraction_ppm in 50_000u32..=1_000_000,
    ) {
        let turns = build(&specs);
        let active = active_pick.and_then(|i| turns.get(i)).map(|t| t.turn_id);
        let prefix = eligible_prefix(&turns, active, epoch);
        let result = select_turns(&turns, active, epoch, fraction_ppm);

        if prefix.is_empty() {
            prop_assert_eq!(result, Err(CompactionError::NoEligibleTurns));
            return Ok(());
        }
        let s = result.unwrap();

        // Oldest chronological prefix of the eligible turns, contiguous.
        let want: Vec<TurnId> = prefix.iter().take(s.turn_ids.len()).map(|t| t.turn_id).collect();
        prop_assert_eq!(&s.turn_ids, &want);
        prop_assert!(!s.turn_ids.is_empty());

        // Only closed, complete, current-epoch, non-retired, non-active turns.
        for id in &s.turn_ids {
            let t = turns.iter().find(|t| t.turn_id == *id).unwrap();
            prop_assert!(t.compaction_closed && t.protocol_complete);
            prop_assert!(t.retired_by_epoch.is_none());
            prop_assert_eq!(t.reset_epoch, epoch);
            prop_assert_ne!(Some(t.turn_id), active);
        }

        // Mass accounting is exactly the sum of per-turn message mass.
        let eligible: u64 = prefix.iter().map(|t| t.accepted_message_tokens).sum();
        let selected: u64 = prefix.iter().take(s.turn_ids.len()).map(|t| t.accepted_message_tokens).sum();
        prop_assert_eq!(s.eligible_mass, eligible);
        prop_assert_eq!(s.selected_mass, selected);

        // Target = ceil(eligible * fraction / 1e6), at least 1.
        let scaled = u128::from(eligible) * u128::from(fraction_ppm);
        let target = std::cmp::max(1, scaled.div_ceil(1_000_000)) as u64;
        prop_assert_eq!(s.target_mass, target);

        // Reaches the target unless the whole prefix is exhausted.
        prop_assert!(s.selected_mass >= s.target_mass || s.turn_ids.len() == prefix.len());

        // No proper selected prefix reaches the target.
        let mut running = 0u64;
        for t in prefix.iter().take(s.turn_ids.len().saturating_sub(1)) {
            running += t.accepted_message_tokens;
            prop_assert!(running < s.target_mass);
        }

        // Source range spans first start to last closure.
        let first = prefix.first().unwrap();
        let last = prefix[s.turn_ids.len() - 1];
        prop_assert_eq!(s.source_start_sequence, first.start_sequence);
        prop_assert_eq!(s.source_end_sequence, last.closure_sequence);
    }

    #[test]
    fn selection_ignores_input_order(
        specs in prop::collection::vec(spec_strategy(), 0..16),
        epoch in 0u32..=2,
        fraction_ppm in 50_000u32..=1_000_000,
        seed in any::<u64>(),
    ) {
        let turns = build(&specs);
        let mut shuffled = turns.clone();
        // Deterministic Fisher-Yates driven by `seed`; no wall clock involved.
        let mut state = seed | 1;
        for i in (1..shuffled.len()).rev() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            shuffled.swap(i, (state % (i as u64 + 1)) as usize);
        }
        prop_assert_eq!(
            select_turns(&turns, None, epoch, fraction_ppm),
            select_turns(&shuffled, None, epoch, fraction_ppm)
        );
    }

    #[test]
    fn pressure_hysteresis_matches_reference(
        fills in prop::collection::vec(0u64..=1_500_000, 1..64),
    ) {
        let t = defaults();
        let mut state = PressureState::Normal;
        for fill in fills {
            let next = next_pressure_state(state, fill, t);
            let want = match state {
                PressureState::Normal if fill >= 600_000 => PressureState::High,
                PressureState::High if fill <= 450_000 => PressureState::Normal,
                other => other,
            };
            prop_assert_eq!(next, want);
            state = next;
        }
    }
}
