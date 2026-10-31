//! Memory plugin contract (Memory spec §5).
//!
//! P6-1 ships the contract only: the three traits below and the language-neutral
//! DTOs in [`dto`]. No manager, host implementation, fake plugin, or storage
//! lives here yet (P6-2/P6-3).

use async_trait::async_trait;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// API version of this memory contract (spec §5). A plugin whose manifest
/// reports any other value is disabled before `open`.
pub const MEMORY_API_VERSION: u32 = 1;

pub mod dto;

pub use dto::*;

/// A memory plugin. Opening is async and returns a boxed [`MemorySession`];
/// the plugin owns its backend and session state.
#[async_trait]
pub trait MemoryPlugin: Send + Sync + 'static {
    fn manifest(&self) -> MemoryPluginManifest;

    async fn open(
        &self,
        request: MemoryOpenRequest,
        host: Arc<dyn MemoryPluginHost>,
        cancel: CancellationToken,
    ) -> Result<Box<dyn MemorySession>, MemoryPluginError>;
}

/// One plugin session for one PRAANA session. Called serially by the memory
/// manager; a plugin MUST NOT require concurrent calls on one session object.
#[async_trait]
pub trait MemorySession: Send + 'static {
    fn capabilities(&self) -> MemoryCapabilities;

    async fn start(
        &mut self,
        input: MemorySessionStart,
        cancel: CancellationToken,
    ) -> Result<MemoryBootstrap, MemoryPluginError>;

    async fn recall(
        &mut self,
        input: RecallQuery,
        cancel: CancellationToken,
    ) -> Result<RecallResult, MemoryPluginError>;

    async fn remember(
        &mut self,
        input: RememberInput,
        cancel: CancellationToken,
    ) -> Result<RememberResult, MemoryPluginError>;

    async fn retract(
        &mut self,
        input: RetractMemoryInput,
        cancel: CancellationToken,
    ) -> Result<RetractMemoryResult, MemoryPluginError>;

    async fn pin(
        &mut self,
        input: PinMemoryInput,
        cancel: CancellationToken,
    ) -> Result<PinMemoryResult, MemoryPluginError>;

    async fn feedback(
        &mut self,
        input: MemoryFeedback,
        cancel: CancellationToken,
    ) -> Result<MemoryFeedbackResult, MemoryPluginError>;

    async fn end(
        &mut self,
        input: MemorySessionEnd,
        cancel: CancellationToken,
    ) -> Result<MemorySessionEndResult, MemoryPluginError>;

    async fn stats(
        &self,
        cancel: CancellationToken,
    ) -> Result<MemoryStats, MemoryPluginError>;

    async fn close(
        self: Box<Self>,
        cancel: CancellationToken,
    ) -> Result<(), MemoryPluginError>;
}

/// The bounded host surface a plugin may call (spec §8). There is no generic
/// callback, filesystem/SQL/network handle, credential lookup, or `Session`
/// reference.
#[async_trait]
pub trait MemoryPluginHost: Send + Sync + 'static {
    fn capabilities(&self) -> MemoryHostCapabilities;
    fn now_ms(&self) -> i64;
    fn new_id(&self, kind: MemoryHostIdKind) -> String;
    fn log(&self, record: MemoryPluginLogRecord);

    async fn complete(
        &self,
        request: MemoryCompletionRequest,
        cancel: CancellationToken,
    ) -> Result<MemoryCompletionResponse, MemoryHostError>;
}
