//! Pressure state, trigger, and hysteresis (Compaction spec §4.2).
//!
//! The hard-ceiling calculation (§4.1) is `provider::openai::admit`. This
//! module owns only the proactive-compaction decision that sits on top of it.

/// Observable hysteresis signal. `High` is not a lockout (spec §4.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PressureState {
    Normal,
    High,
}

/// Trigger and clear thresholds in parts per million of usable input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PressureThresholds {
    pub trigger_ppm: u64,
    pub clear_ppm: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ThresholdError {
    RatioOutOfRange,
    ClearNotBelowTrigger,
}

/// Converts a validated config ratio to ppm, rounding to nearest. Config
/// validation bounds the ratios well inside `0.0..=1.0`; this rejects anything
/// else rather than clamping.
pub fn ratio_to_ppm(ratio: f64) -> Result<u64, ThresholdError> {
    if !ratio.is_finite() || !(0.0..=1.0).contains(&ratio) {
        return Err(ThresholdError::RatioOutOfRange);
    }
    Ok((ratio * 1_000_000.0).round() as u64)
}

impl PressureThresholds {
    pub fn from_ratios(compact_at: f64, compact_clear_at: f64) -> Result<Self, ThresholdError> {
        let trigger_ppm = ratio_to_ppm(compact_at)?;
        let clear_ppm = ratio_to_ppm(compact_clear_at)?;
        if clear_ppm >= trigger_ppm {
            return Err(ThresholdError::ClearNotBelowTrigger);
        }
        Ok(Self {
            trigger_ppm,
            clear_ppm,
        })
    }
}

pub fn next_pressure_state(
    state: PressureState,
    fill_ppm: u64,
    thresholds: PressureThresholds,
) -> PressureState {
    match state {
        PressureState::Normal if fill_ppm >= thresholds.trigger_ppm => PressureState::High,
        PressureState::High if fill_ppm <= thresholds.clear_ppm => PressureState::Normal,
        other => other,
    }
}

/// Proactive launch: at or above the trigger, nothing in flight, and at least
/// one eligible turn the most recent attempt at this projection sequence did
/// not consider. State is deliberately not an input.
pub fn should_launch(
    fill_ppm: u64,
    thresholds: PressureThresholds,
    compaction_in_flight: bool,
    has_unconsidered_eligible_turn: bool,
) -> bool {
    fill_ppm >= thresholds.trigger_ppm && !compaction_in_flight && has_unconsidered_eligible_turn
}
