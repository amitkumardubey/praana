//! Bounded stream capture. Bytes stay in memory up to the caller limit.

use tokio::io::AsyncReadExt;

use crate::tools::error::{ToolError, ToolErrorCode};

pub async fn drain<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
    limit: usize,
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
        let room = limit.saturating_sub(out.len());
        if room == 0 {
            truncated = true;
            break;
        }
        let take = read.min(room);
        out.extend_from_slice(&buf[..take]);
        if take < read {
            truncated = true;
            break;
        }
    }
    Ok((out, truncated))
}
