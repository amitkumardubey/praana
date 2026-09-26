//! Unix process-group supervision. Killing the leader alone is not enough.

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use super::capture::drain;
use super::SuperviseOutput;
use super::SuperviseRequest;
use crate::tools::error::{ToolError, ToolErrorCode};

pub async fn supervise(request: SuperviseRequest) -> Result<SuperviseOutput, ToolError> {
    let mut command = if let Some(argv) = request.argv.as_ref().filter(|argv| !argv.is_empty()) {
        let mut command = Command::new(&argv[0]);
        command.args(&argv[1..]);
        command
    } else {
        let mut command = Command::new("/bin/bash");
        command
            .arg("--noprofile")
            .arg("--norc")
            .arg("-c")
            .arg(&request.command);
        command
    };
    command
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
    let hit_limit = Arc::new(AtomicBool::new(false));
    let limit_notify = Arc::new(Notify::new());
    let stdout_hit = Arc::clone(&hit_limit);
    let stdout_notify = Arc::clone(&limit_notify);
    let stderr_hit = Arc::clone(&hit_limit);
    let stderr_notify = Arc::clone(&limit_notify);
    let mut stdout_task = stdout.map(|mut pipe| {
        tokio::spawn(
            async move { drain(&mut pipe, stdout_limit, &stdout_hit, &stdout_notify).await },
        )
    });
    let mut stderr_task = stderr.map(|mut pipe| {
        tokio::spawn(
            async move { drain(&mut pipe, stderr_limit, &stderr_hit, &stderr_notify).await },
        )
    });
    let cancel = request.cancel.clone();
    let timeout = request.timeout;

    let mut timed_out = false;
    let mut cancelled = false;
    let mut output_limited = false;
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
            _ = wait_for_limit(&hit_limit, &limit_notify) => {
                output_limited = true;
                terminate_group(group_id).await;
                None
            }
            status = &mut wait => status.ok(),
        }
    };
    let (stdout_bytes, stdout_truncated) = finish_capture(&mut stdout_task, group_id).await?;
    let (stderr_bytes, stderr_truncated) = finish_capture(&mut stderr_task, group_id).await?;
    if let Some(group_id) = group_id {
        if group_alive(group_id as i32) {
            terminate_group(Some(group_id)).await;
        }
        if group_alive(group_id as i32) {
            return Err(ToolError::new(
                ToolErrorCode::ToolInternal,
                "process group still alive",
            ));
        }
    }
    drop(child);
    let signal = status.as_ref().and_then(|status| {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|signal| format!("SIG{signal}"))
    });
    let exit_code = status.and_then(|status| status.code());
    Ok(SuperviseOutput {
        stdout: stdout_bytes,
        stderr: stderr_bytes,
        exit_code,
        timed_out,
        cancelled,
        truncated: stdout_truncated || stderr_truncated || output_limited,
        group_id,
        signal,
    })
}

async fn wait_for_limit(hit: &AtomicBool, notify: &Notify) {
    loop {
        if hit.load(Ordering::SeqCst) {
            return;
        }
        tokio::select! {
            _ = notify.notified() => {}
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    }
}

type DrainTask = JoinHandle<Result<(Vec<u8>, bool), ToolError>>;

async fn finish_capture(
    task: &mut Option<DrainTask>,
    group_id: Option<u32>,
) -> Result<(Vec<u8>, bool), ToolError> {
    let Some(task) = task.as_mut() else {
        return Ok((Vec::new(), false));
    };
    let joined = match tokio::time::timeout(Duration::from_millis(1000), &mut *task).await {
        Ok(joined) => joined,
        Err(_) => {
            terminate_group(group_id).await;
            match tokio::time::timeout(Duration::from_millis(1000), &mut *task).await {
                Ok(joined) => joined,
                Err(_) => {
                    task.abort();
                    return Err(ToolError::new(
                        ToolErrorCode::ToolInternal,
                        "process output was not drained",
                    ));
                }
            }
        }
    };
    joined.map_err(|_| ToolError::new(ToolErrorCode::ToolIoFailed, "output capture failed"))?
}

async fn terminate_group(group_id: Option<u32>) {
    let Some(group_id) = group_id else {
        return;
    };
    let pgid = group_id as i32;
    unsafe {
        libc::kill(-pgid, libc::SIGTERM);
    }
    for _ in 0..50 {
        if !group_alive(pgid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if group_alive(pgid) {
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub fn group_alive(pgid: i32) -> bool {
    unsafe {
        // A zombie leader still answers kill(0). Reap exited members so a
        // group that has already died does not look alive for the whole grace.
        loop {
            let waited = libc::waitpid(-pgid, std::ptr::null_mut(), libc::WNOHANG);
            if waited <= 0 {
                break;
            }
        }
        libc::kill(-pgid, 0) == 0
    }
}
