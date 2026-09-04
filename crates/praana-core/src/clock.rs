//! Deterministic clock and sleeper foundations for the Rust v2 core.

use std::time::Duration;

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

pub trait Sleeper: Send + Sync {
    fn sleep(&self, duration: Duration);
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

#[derive(Debug, Default, Clone, Copy)]
pub struct ThreadSleeper;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(since) => {
                let millis = since.as_millis();
                if millis > i64::MAX as u128 {
                    i64::MAX
                } else {
                    millis as i64
                }
            }
            Err(before) => {
                let before = before.duration();
                let millis = before.as_millis();
                if millis > i64::MAX as u128 {
                    i64::MIN
                } else {
                    -(millis as i64)
                }
            }
        }
    }
}

impl Sleeper for ThreadSleeper {
    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}
