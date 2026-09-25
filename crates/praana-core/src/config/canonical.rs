use super::error::ConfigError;
use super::types::EffectiveConfigV1;
use crate::canonical_json;
use crate::token::Sha256Digest;
use std::path::{Path, PathBuf};

impl EffectiveConfigV1 {
    pub fn to_canonical_json_bytes(&self) -> Vec<u8> {
        canonical_json::to_canonical_json_bytes(self)
            .expect("EffectiveConfigV1 must serialize to RFC 8785 canonical JSON")
    }

    pub fn config_digest_sha256(&self) -> Sha256Digest {
        let bytes = self.to_canonical_json_bytes();
        Sha256Digest::digest_bytes(&bytes)
    }

    pub fn request_live_reload(&self) -> Result<(), ConfigError> {
        Err(ConfigError::ReloadUnsupported)
    }

    /// Write config.snapshot.json in caller-supplied session directory as RFC 8785 + one LF,
    /// created with mode 0o600 on Unix.
    pub fn write_config_snapshot(&self, session_dir: &Path) -> Result<PathBuf, ConfigError> {
        let snapshot_path = session_dir.join("config.snapshot.json");
        let mut bytes = self.to_canonical_json_bytes();
        bytes.push(b'\n');

        #[cfg(unix)]
        {
            use std::fs::OpenOptions;
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;

            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&snapshot_path)
                .map_err(|e| {
                    if e.kind() == std::io::ErrorKind::AlreadyExists {
                        ConfigError::SnapshotMismatch(format!(
                            "snapshot already exists at {}",
                            snapshot_path.display()
                        ))
                    } else {
                        ConfigError::SourceInvalid(format!("failed to create snapshot: {e}"))
                    }
                })?;
            file.write_all(&bytes).map_err(|e| {
                ConfigError::SourceInvalid(format!("failed to write snapshot: {e}"))
            })?;
        }

        #[cfg(not(unix))]
        {
            use std::fs::OpenOptions;
            use std::io::Write;

            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&snapshot_path)
                .map_err(|e| {
                    if e.kind() == std::io::ErrorKind::AlreadyExists {
                        ConfigError::SnapshotMismatch(format!(
                            "snapshot already exists at {}",
                            snapshot_path.display()
                        ))
                    } else {
                        ConfigError::SourceInvalid(format!("failed to create snapshot: {e}"))
                    }
                })?;
            file.write_all(&bytes).map_err(|e| {
                ConfigError::SourceInvalid(format!("failed to write snapshot: {e}"))
            })?;
        }

        Ok(snapshot_path)
    }
}
