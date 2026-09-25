//! Assignment-key normalization shared with structured traversal.
//!
//! Pattern matching stays in the P1D detector. This module only exposes the
//! key and exemption predicates that traversal needs.

use super::detectors::{key_matches_assignment, value_is_assignment_exempt};

pub(crate) fn key_is_assignment(key: &str) -> bool {
    key_matches_assignment(key)
}

pub(crate) fn value_is_exempt(value: &str) -> bool {
    value_is_assignment_exempt(value)
}
