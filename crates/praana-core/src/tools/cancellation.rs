//! Session, turn, and call cancellation. A parent cancel reaches descendants.

use tokio_util::sync::CancellationToken;

pub struct CancelHub {
    application: CancellationToken,
}

impl CancelHub {
    pub fn new() -> Self {
        Self {
            application: CancellationToken::new(),
        }
    }

    pub fn application(&self) -> CancellationToken {
        self.application.clone()
    }

    pub fn session(&self) -> CancellationToken {
        self.application.child_token()
    }

    pub fn child(parent: &CancellationToken) -> CancellationToken {
        parent.child_token()
    }
}

impl Default for CancelHub {
    fn default() -> Self {
        Self::new()
    }
}
