//! Fixed hook stages. LSP and verify stay seams until their packets.

pub mod circuit;
pub mod enrich;
pub mod lsp;
pub mod plan;
pub mod redact;
pub mod risk;
pub mod validate;
pub mod verify;

use std::sync::{Arc, Mutex, RwLock};

#[derive(Clone)]
pub struct HookTrace {
    slot: Arc<RwLock<Arc<Mutex<Vec<String>>>>>,
}

impl Default for HookTrace {
    fn default() -> Self {
        Self {
            slot: Arc::new(RwLock::new(Arc::new(Mutex::new(Vec::new())))),
        }
    }
}

impl HookTrace {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&self, stage: &str) {
        self.buffer()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(stage.to_owned());
    }

    pub fn snapshot(&self) -> Vec<String> {
        self.buffer()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    pub fn replace_from(&self, other: &HookTrace) {
        let shared = other.buffer();
        *self.slot.write().unwrap_or_else(|err| err.into_inner()) = shared;
    }

    fn buffer(&self) -> Arc<Mutex<Vec<String>>> {
        self.slot
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }
}
