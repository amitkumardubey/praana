//! Process-abort failpoints for crash/recovery integration tests.
//!
//! This module is compiled only by the `failpoints` feature. Normal production
//! builds contain no hooks; feature-enabled debug builds remain inert unless a
//! dedicated integration-test executable calls the explicit test arm.

use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Armed {
    label: String,
    occurrence: usize,
}

static ARMED: OnceLock<Option<Armed>> = OnceLock::new();
static HITS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub(crate) fn arm_for_test(raw: &str) -> Result<(), &'static str> {
    let (label, occurrence) = raw.rsplit_once('@').unwrap_or((raw, "1"));
    if label.is_empty() {
        return Err("failpoint label is empty");
    }
    let occurrence = occurrence
        .parse::<usize>()
        .map_err(|_| "failpoint occurrence is invalid")?
        .max(1);
    ARMED
        .set(Some(Armed {
            label: label.to_owned(),
            occurrence,
        }))
        .map_err(|_| "failpoint was already armed")
}

fn armed() -> &'static Option<Armed> {
    // Deliberately do not inspect process environment here. A feature-enabled
    // debug library remains inert unless an integration-test executable calls
    // the explicit test arm exported by lib.rs.
    ARMED.get_or_init(|| None)
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
