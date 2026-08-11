#![deny(clippy::all)]

use napi_derive::napi;

/// Semver of the native *API surface* (independent of npm package version).
/// Bump major when removing/renaming exports or changing result shapes incompatibly.
pub const NATIVE_API_VERSION: &str = "0.1.0";

#[napi]
pub fn native_version() -> String {
  NATIVE_API_VERSION.to_string()
}

#[napi]
pub fn ping() -> String {
  "pong".to_string()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn version_is_semverish() {
    assert!(NATIVE_API_VERSION.contains('.'));
  }

  #[test]
  fn ping_returns_pong() {
    assert_eq!(ping(), "pong");
  }
}
