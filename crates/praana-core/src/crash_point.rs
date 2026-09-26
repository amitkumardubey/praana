//! Process-abort failpoints for crash/recovery integration tests.
//!
//! This module is compiled only by the `failpoints` feature. Production builds
//! have no call sites because every invocation is cfg-gated at its boundary.

use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Armed {
    label: String,
    occurrence: usize,
}

static ARMED: OnceLock<Option<Armed>> = OnceLock::new();
static HITS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn armed() -> &'static Option<Armed> {
    ARMED.get_or_init(|| {
        let raw = std::env::var("PRAANA_CRASH_POINT").ok()?;
        let (label, occurrence) = raw.rsplit_once('@').unwrap_or((&raw, "1"));
        let occurrence = occurrence.parse::<usize>().ok()?.max(1);
        Some(Armed {
            label: label.to_owned(),
            occurrence,
        })
    })
}

pub fn hit(label: impl AsRef<str>) {
    let Some(armed) = armed() else {
        return;
    };
    if armed.label != label.as_ref() {
        return;
    }
    let hit = HITS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    if hit == armed.occurrence {
        std::process::abort();
    }
}
