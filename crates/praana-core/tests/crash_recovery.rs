//! Process-abort recovery matrix. This binary is built only with `failpoints`.

use std::path::PathBuf;
use std::sync::Arc;

use praana_core::clock::{Clock, ThreadSleeper};
use praana_core::config::build_defaults;
use praana_core::id::{IdGenerationError, MonotonicUlidGenerator, RandomSource};
use praana_core::turn::{HeadlessLoop, LoopConfig, LoopFault};

struct FixedClock(i64);

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

struct SeqRandom(u128);

impl RandomSource for SeqRandom {
    fn next_random_80(&mut self) -> Result<u128, IdGenerationError> {
        self.0 += 1;
        Ok(self.0)
    }
}

fn config(root: PathBuf) -> LoopConfig {
    let mut effective = build_defaults(PathBuf::from("/praana-home").as_path());
    effective.llm.context_window = 128_000;
    effective.llm.provider = "scripted".into();
    effective.llm.protocol = "scripted-v1".into();
    effective.llm.model = "fake".into();
    effective.history.safety_margin_min_tokens = 0;
    effective.history.safety_margin_ratio = 0.0;
    LoopConfig {
        session_dir: root.join("session"),
        workspace: root.join("work"),
        config: effective,
        clock: Arc::new(FixedClock(1_700_000_000_000)),
        ids: Arc::new(MonotonicUlidGenerator::new(
            Arc::new(FixedClock(1_700_000_000_000)),
            Arc::new(ThreadSleeper),
            Box::new(SeqRandom(1)),
        )),
        fault: LoopFault::None,
    }
}

#[test]
fn child_aborts_after_session_started_write() {
    let Ok(root) = std::env::var("PRAANA_CRASH_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let _ = HeadlessLoop::create(config(root));
}

#[test]
fn crash_after_event_write_before_fsync_is_a_real_process_abort() {
    let root = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "child_aborts_after_session_started_write"])
        .env("PRAANA_CRASH_ROOT", root.path())
        .env(
            "PRAANA_CRASH_POINT",
            "event.write_before_fsync:session_started:1@1",
        )
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "child unexpectedly succeeded: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(root.path().join("session").join("events.jsonl").exists());
}
