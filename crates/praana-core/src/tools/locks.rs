//! Non-waiting per-path locks. Keys are lexically normalized.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::error::{ToolError, ToolErrorCode};
use super::intent::normalize_lexical;

struct LockState {
    readers: u32,
    writer: bool,
}

pub struct PathLockTable {
    inner: Mutex<HashMap<PathBuf, LockState>>,
}

pub struct PathLease {
    table: std::sync::Arc<PathLockTable>,
    keys: Vec<PathBuf>,
}

impl PathLockTable {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            inner: Mutex::new(HashMap::new()),
        })
    }

    pub fn try_acquire(
        self: &std::sync::Arc<Self>,
        cwd: &Path,
        requested: &str,
        write: bool,
        _call_id: &str,
    ) -> Result<PathLease, ToolError> {
        let key = normalize_lexical(cwd, requested)?;
        self.try_acquire_keys(vec![(key, write)])
    }

    pub fn try_acquire_keys(
        self: &std::sync::Arc<Self>,
        mut keys: Vec<(PathBuf, bool)>,
    ) -> Result<PathLease, ToolError> {
        keys.sort_by(|a, b| a.0.cmp(&b.0));
        keys.dedup_by(|later, earlier| {
            if later.0 == earlier.0 {
                earlier.1 = earlier.1 || later.1;
                true
            } else {
                false
            }
        });
        let mut guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        for (key, write) in &keys {
            if let Some(state) = guard.get(key) {
                let conflict = if *write {
                    state.writer || state.readers > 0
                } else {
                    state.writer
                };
                if conflict {
                    return Err(ToolError::new(
                        ToolErrorCode::ToolPathBusy,
                        "path is already locked",
                    ));
                }
            }
        }
        for (key, write) in &keys {
            let state = guard.entry(key.clone()).or_insert(LockState {
                readers: 0,
                writer: false,
            });
            if *write {
                state.writer = true;
            } else {
                state.readers += 1;
            }
        }
        drop(guard);
        Ok(PathLease {
            table: std::sync::Arc::clone(self),
            keys: keys.into_iter().map(|(key, _)| key).collect(),
        })
    }

    pub fn held_count(&self) -> usize {
        let guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        guard.len()
    }

    fn release(&self, keys: &[PathBuf]) {
        let mut guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        for key in keys {
            let remove = if let Some(state) = guard.get_mut(key) {
                if state.writer {
                    state.writer = false;
                } else if state.readers > 0 {
                    state.readers -= 1;
                }
                !state.writer && state.readers == 0
            } else {
                false
            };
            if remove {
                guard.remove(key);
            }
        }
    }
}

impl std::fmt::Debug for PathLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PathLease")
            .field("keys", &self.keys)
            .finish()
    }
}

impl Drop for PathLease {
    fn drop(&mut self) {
        self.table.release(&self.keys);
    }
}

impl Default for PathLockTable {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}
