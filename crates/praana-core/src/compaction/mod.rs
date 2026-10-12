//! Admission pressure and complete-turn compaction (Compaction spec §4.2–§6).
//!
//! P5-1 scope: pure pressure state and closed-turn selection. Nothing here
//! touches History, a provider, or the turn loop.

pub mod admission;
pub mod selection;

use crate::protocol::id::TurnId;

/// Internal compaction/admission failures (Compaction spec §21). The canonical
/// class and IPC mapping live in Protocol Appendix A.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CompactionError {
    NoEligibleTurns,
    MissingTokenMass(TurnId),
    ArithmeticOverflow,
}

impl CompactionError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoEligibleTurns => "COMPACTION_NO_ELIGIBLE_TURNS",
            Self::MissingTokenMass(_) => "COMPACTION_MISSING_TOKEN_MASS",
            Self::ArithmeticOverflow => "ADMISSION_ARITHMETIC_OVERFLOW",
        }
    }
}

impl std::fmt::Display for CompactionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingTokenMass(turn) => write!(f, "{}: turn {turn}", self.code()),
            _ => f.write_str(self.code()),
        }
    }
}

impl std::error::Error for CompactionError {}
