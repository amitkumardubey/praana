//! Process-abort failpoints for crash/recovery integration tests.
//!
//! This module is compiled only by the `failpoints` feature. Normal production
//! builds contain no hooks; feature-enabled debug builds remain inert unless a
//! test arms an abort or registers a rebuild pause/fail hook. Neither path
//! reads environment variables.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

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

/// What a registered rebuild hook does the next time its label is reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RebuildHookKind {
    /// Block the rebuild until [`RebuildHookGuard::resume`].
    Pause,
    /// Fail this pass with an `io::Error` and do not run it again.
    Fail,
}

struct HookRegistration {
    path: PathBuf,
    actions: HashMap<String, RebuildHookKind>,
    paused: Option<String>,
}

static HOOK_TEST_LOCK: Mutex<()> = Mutex::new(());
static HOOK: Mutex<Option<HookRegistration>> = Mutex::new(None);
static HOOK_CV: Condvar = Condvar::new();

/// Clears the rebuild hook on drop and holds the process-wide registration lock.
pub struct RebuildHookGuard {
    _permit: MutexGuard<'static, ()>,
}

impl Drop for RebuildHookGuard {
    fn drop(&mut self) {
        let mut slot = HOOK.lock().unwrap_or_else(|err| err.into_inner());
        *slot = None;
        HOOK_CV.notify_all();
    }
}

/// Register pause and fail actions for a rebuild of `path`. Other databases
/// in the same process are ignored. Drop the guard to clear the registration.
pub fn register_rebuild_hook(path: &Path, actions: &[(&str, RebuildHookKind)]) -> RebuildHookGuard {
    let permit = HOOK_TEST_LOCK.lock().unwrap_or_else(|err| err.into_inner());
    let mut map = HashMap::new();
    for (label, kind) in actions {
        map.insert((*label).to_string(), *kind);
    }
    *HOOK.lock().unwrap_or_else(|err| err.into_inner()) = Some(HookRegistration {
        path: path.to_path_buf(),
        actions: map,
        paused: None,
    });
    RebuildHookGuard { _permit: permit }
}

impl RebuildHookGuard {
    /// Wait until the rebuild of the registered path pauses at `label`.
    pub fn wait_paused(&self, label: &str, timeout: Duration) -> bool {
        let guard = HOOK.lock().unwrap_or_else(|err| err.into_inner());
        let (guard, wait) = HOOK_CV
            .wait_timeout_while(guard, timeout, |slot| {
                slot.as_ref().and_then(|state| state.paused.as_deref()) != Some(label)
            })
            .unwrap_or_else(|err| err.into_inner());
        !wait.timed_out() && guard.as_ref().and_then(|state| state.paused.as_deref()) == Some(label)
    }

    /// Release a rebuild paused at a hook label.
    pub fn resume(&self) {
        let mut guard = HOOK.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(state) = guard.as_mut() {
            state.paused = None;
        }
        HOOK_CV.notify_all();
    }
}

pub(crate) fn check_rebuild_hook(label: &str, path: &Path) -> Result<(), std::io::Error> {
    let mut guard = HOOK.lock().unwrap_or_else(|err| err.into_inner());
    {
        let Some(state) = guard.as_mut() else {
            return Ok(());
        };
        if state.path != path {
            return Ok(());
        }
        let Some(kind) = state.actions.get(label).copied() else {
            return Ok(());
        };
        match kind {
            RebuildHookKind::Fail => {
                state.actions.remove(label);
                #[allow(clippy::io_other_error)]
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("injected failure at {label}"),
                ));
            }
            RebuildHookKind::Pause => {
                state.paused = Some(label.to_owned());
                state.actions.remove(label);
            }
        }
    }
    HOOK_CV.notify_all();
    loop {
        let still = guard.as_ref().and_then(|state| state.paused.as_deref()) == Some(label);
        if !still {
            return Ok(());
        }
        guard = HOOK_CV.wait(guard).unwrap_or_else(|err| err.into_inner());
    }
}
