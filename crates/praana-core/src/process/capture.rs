//! Bounded stream capture. Overflow is discarded while the read continues
//! so a writer blocked on a full pipe can still be reaped.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

use crate::tools::error::{ToolError, ToolErrorCode};

pub async fn drain<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
    limit: usize,
    hit_limit: &Arc<AtomicBool>,
    notify: &Arc<Notify>,
) -> Result<(Vec<u8>, bool), ToolError> {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    let mut truncated = false;
    loop {
        let read = reader
            .read(&mut buf)
            .await
            .map_err(|_| ToolError::new(ToolErrorCode::ToolIoFailed, "output capture failed"))?;
        if read == 0 {
            break;
        }
        if out.len() >= limit {
            note_limit(&mut truncated, hit_limit, notify);
            continue;
        }
        let room = limit - out.len();
        let take = read.min(room);
        out.extend_from_slice(&buf[..take]);
        if take < read {
            note_limit(&mut truncated, hit_limit, notify);
        }
    }
    Ok((out, truncated))
}

fn note_limit(truncated: &mut bool, hit_limit: &AtomicBool, notify: &Notify) {
    *truncated = true;
    if !hit_limit.swap(true, Ordering::SeqCst) {
        notify.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn overflow_is_drained_until_the_writer_finishes() {
        let (mut reader, mut writer) = tokio::io::duplex(16);
        let finished = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&finished);
        let write = tokio::spawn(async move {
            writer.write_all(&[7u8; 64]).await.unwrap();
            writer.shutdown().await.unwrap();
            flag.store(true, Ordering::SeqCst);
        });
        let hit = Arc::new(AtomicBool::new(false));
        let notify = Arc::new(Notify::new());
        let (bytes, truncated) = drain(&mut reader, 10, &hit, &notify).await.unwrap();
        write.await.unwrap();
        assert!(truncated);
        assert_eq!(bytes.len(), 10);
        assert!(finished.load(Ordering::SeqCst));
    }
}
