//! Unix process-group supervision. Killing the leader alone is not enough.

use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use super::capture::drain;
use super::SuperviseOutput;
use super::SuperviseRequest;
use crate::tools::error::{ToolError, ToolErrorCode};

pub async fn supervise(request: SuperviseRequest) -> Result<SuperviseOutput, ToolError> {
    let mut command = Command::new("/bin/bash");
    command
        .arg("--noprofile")
        .arg("--norc")
        .arg("-c")
        .arg(&request.command)
        .current_dir(&request.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .envs(
            request
                .env
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        )
        .kill_on_drop(true);
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|_| {
        ToolError::new(
            ToolErrorCode::ToolProcessSpawnFailed,
            "process spawn failed",
        )
    })?;
    let group_id = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_limit = request.stdout_limit;
    let stderr_limit = request.stderr_limit;
    let stdout_task =
        stdout.map(|mut pipe| tokio::spawn(async move { drain(&mut pipe, stdout_limit).await }));
    let stderr_task =
        stderr.map(|mut pipe| tokio::spawn(async move { drain(&mut pipe, stderr_limit).await }));
    let cancel = request.cancel.clone();
    let timeout = request.timeout;

    let mut timed_out = false;
    let mut cancelled = false;
    let status = {
        let wait = child.wait();
        tokio::pin!(wait);
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                cancelled = true;
                terminate_group(group_id).await;
                None
            }
            _ = tokio::time::sleep(timeout) => {
                timed_out = true;
                terminate_group(group_id).await;
                None
            }
            status = &mut wait => status.ok(),
        }
    };
    let (stdout_bytes, stdout_truncated) = match stdout_task {
        Some(task) => task
            .await
            .map_err(|_| ToolError::new(ToolErrorCode::ToolIoFailed, "output capture failed"))??,
        None => (Vec::new(), false),
    };
    let (stderr_bytes, stderr_truncated) = match stderr_task {
        Some(task) => task
            .await
            .map_err(|_| ToolError::new(ToolErrorCode::ToolIoFailed, "output capture failed"))??,
        None => (Vec::new(), false),
    };
    drop(child);
    let exit_code = status.and_then(|status| status.code());
    Ok(SuperviseOutput {
        stdout: stdout_bytes,
        stderr: stderr_bytes,
        exit_code,
        timed_out,
        cancelled,
        truncated: stdout_truncated || stderr_truncated,
        group_id,
    })
}

async fn terminate_group(group_id: Option<u32>) {
    let Some(group_id) = group_id else {
        return;
    };
    let pgid = group_id as i32;
    unsafe {
        libc::kill(-pgid, libc::SIGTERM);
    }
    tokio::time::sleep(Duration::from_millis(1000)).await;
    if group_alive(pgid) {
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub fn group_alive(pgid: i32) -> bool {
    unsafe { libc::kill(-pgid, 0) == 0 }
}
