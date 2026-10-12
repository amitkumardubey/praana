//! Complete-turn selection (Compaction spec §5.1 and §6).

use crate::compaction::CompactionError;
use crate::protocol::id::TurnId;

/// One retained outer turn as the compaction snapshot sees it. Token mass is
/// the adapter estimate of its model-visible real messages only (spec §6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectedTurn {
    pub turn_id: TurnId,
    pub start_sequence: u64,
    /// Commit or interruption sequence. Meaningful when `compaction_closed`.
    pub closure_sequence: u64,
    pub reset_epoch: u32,
    pub retired_by_epoch: Option<u32>,
    /// True exactly for a committed turn or a validated interrupted capsule.
    pub compaction_closed: bool,
    pub protocol_complete: bool,
    pub accepted_message_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    pub turn_ids: Vec<TurnId>,
    pub source_start_sequence: u64,
    pub source_end_sequence: u64,
    pub eligible_mass: u64,
    pub target_mass: u64,
    pub selected_mass: u64,
}

/// Selects the oldest chronological prefix of eligible turns whose mass first
/// reaches `fraction_ppm` of the eligible mass, rounded up at turn boundaries.
/// An ineligible turn is a barrier; the range is never discontiguous.
pub fn select_turns(
    retained: &[ProjectedTurn],
    active_turn: Option<TurnId>,
    reset_epoch: u32,
    fraction_ppm: u32,
) -> Result<Selection, CompactionError> {
    let mut ordered: Vec<&ProjectedTurn> = retained.iter().collect();
    ordered.sort_by_key(|turn| turn.start_sequence);
    let mut eligible_prefix = Vec::new();

    for turn in ordered {
        if turn.reset_epoch != reset_epoch {
            continue;
        }
        if active_turn == Some(turn.turn_id) {
            break;
        }
        if turn.retired_by_epoch.is_some() {
            continue;
        }
        if !turn.compaction_closed || !turn.protocol_complete {
            break;
        }
        if turn.accepted_message_tokens == 0 {
            return Err(CompactionError::MissingTokenMass(turn.turn_id));
        }
        eligible_prefix.push(turn);
    }

    if eligible_prefix.is_empty() {
        return Err(CompactionError::NoEligibleTurns);
    }

    let eligible_mass = eligible_prefix.iter().try_fold(0_u64, |sum, turn| {
        sum.checked_add(turn.accepted_message_tokens)
            .ok_or(CompactionError::ArithmeticOverflow)
    })?;
    let scaled = eligible_mass
        .checked_mul(u64::from(fraction_ppm))
        .ok_or(CompactionError::ArithmeticOverflow)?;
    let target_mass = std::cmp::max(1, scaled.div_ceil(1_000_000));

    let mut selected = Vec::new();
    let mut selected_mass = 0_u64;
    for turn in &eligible_prefix {
        selected.push(*turn);
        selected_mass = selected_mass
            .checked_add(turn.accepted_message_tokens)
            .ok_or(CompactionError::ArithmeticOverflow)?;
        if selected_mass >= target_mass {
            break;
        }
    }

    let first = selected.first().ok_or(CompactionError::NoEligibleTurns)?;
    let last = selected.last().ok_or(CompactionError::NoEligibleTurns)?;
    Ok(Selection {
        turn_ids: selected.iter().map(|turn| turn.turn_id).collect(),
        source_start_sequence: first.start_sequence,
        source_end_sequence: last.closure_sequence,
        eligible_mass,
        target_mass,
        selected_mass,
    })
}
