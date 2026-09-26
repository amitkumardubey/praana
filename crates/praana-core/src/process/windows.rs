//! Windows Job Object supervision.
//!
//! The process is created suspended, assigned to one retained job, then resumed.
//! Timeout and cancel signal that same job. The child receives the sanitized
//! environment block, and both pipes are drained while the process is alive.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::argv::quote_windows_command;
use super::env::unicode_environment_block;
use super::{SuperviseOutput, SuperviseRequest};
use crate::tools::error::{ToolError, ToolErrorCode};

pub async fn supervise(request: SuperviseRequest) -> Result<SuperviseOutput, ToolError> {
    let spawned = spawn_suspended(&request)?;
    let group_id = Some(spawned.pid);
    let stdout_read = SharedHandle::from_raw(spawned.stdout_read);
    let stderr_read = SharedHandle::from_raw(spawned.stderr_read);
    let stdout_limit = request.stdout_limit;
    let stderr_limit = request.stderr_limit;
    let hit_limit = Arc::new(AtomicBool::new(false));
    let stdout_hit = Arc::clone(&hit_limit);
    let stderr_hit = Arc::clone(&hit_limit);
    let stdout_task =
        tokio::task::spawn_blocking(move || read_pipe(stdout_read, stdout_limit, &stdout_hit));
    let stderr_task =
        tokio::task::spawn_blocking(move || read_pipe(stderr_read, stderr_limit, &stderr_hit));
    let cancel = request.cancel.clone();
    let timeout = request.timeout;
    let process = SharedHandle::from_raw(spawned.process);
    let mut wait_task = spawn_wait(process);
    let mut timed_out = false;
    let mut cancelled = false;
    let mut output_limited = false;
    let status = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            cancelled = true;
            terminate_job(&spawned, 130).await;
            None
        }
        _ = tokio::time::sleep(timeout) => {
            timed_out = true;
            terminate_job(&spawned, 124).await;
            None
        }
        _ = wait_for_limit(&hit_limit) => {
            output_limited = true;
            terminate_job(&spawned, 1).await;
            None
        }
        code = &mut wait_task => code.ok().flatten(),
    };
    if timed_out || cancelled || output_limited {
        // TerminateJobObject has unblocked WaitForSingleObject. Join that
        // thread before this function closes the process handle.
        let _ = wait_task.await;
    }
    let mut stdout_task = stdout_task;
    let mut stderr_task = stderr_task;
    let stdout = finish_pipe(&mut stdout_task, &spawned, &mut output_limited).await;
    let stderr = finish_pipe(&mut stderr_task, &spawned, &mut output_limited).await;
    close_handle(spawned.job);
    close_handle(spawned.process);
    close_handle(spawned.thread);
    Ok(SuperviseOutput {
        stdout: stdout.0,
        stderr: stderr.0,
        exit_code: status,
        timed_out,
        cancelled,
        truncated: stdout.1 || stderr.1 || output_limited,
        group_id,
        signal: None,
    })
}

struct Spawned {
    process: windows_sys::Win32::Foundation::HANDLE,
    thread: windows_sys::Win32::Foundation::HANDLE,
    job: windows_sys::Win32::Foundation::HANDLE,
    pid: u32,
    stdout_read: windows_sys::Win32::Foundation::HANDLE,
    stderr_read: windows_sys::Win32::Foundation::HANDLE,
}

/// Raw Windows handles are pointers. The wrapper makes a copied handle `Send`
/// so pipe drains can run on blocking threads while the async worker waits.
#[derive(Clone, Copy)]
struct SharedHandle(usize);

// SAFETY: a `HANDLE` is an opaque pointer copied by value. The blocking task
// does not close it while the supervisor still owns the same value.
unsafe impl Send for SharedHandle {}

impl SharedHandle {
    fn from_raw(handle: windows_sys::Win32::Foundation::HANDLE) -> Self {
        Self(handle as usize)
    }

    fn as_raw(self) -> windows_sys::Win32::Foundation::HANDLE {
        self.0 as windows_sys::Win32::Foundation::HANDLE
    }
}

fn spawn_suspended(request: &SuperviseRequest) -> Result<Spawned, ToolError> {
    unsafe {
        let (stdout_read, stdout_write) = inheritable_pipe()?;
        let (stderr_read, stderr_write) = inheritable_pipe()?;
        let job = windows_sys::Win32::System::JobObjects::CreateJobObjectW(
            std::ptr::null(),
            std::ptr::null(),
        );
        if job.is_null() {
            close_handle(stdout_read);
            close_handle(stdout_write);
            close_handle(stderr_read);
            close_handle(stderr_write);
            return Err(spawn_error());
        }
        let mut info: windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
            std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags =
            windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if windows_sys::Win32::System::JobObjects::SetInformationJobObject(
            job,
            windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&info) as u32,
        ) == 0
        {
            close_handle(job);
            close_handle(stdout_read);
            close_handle(stdout_write);
            close_handle(stderr_read);
            close_handle(stderr_write);
            return Err(spawn_error());
        }
        let mut startup: windows_sys::Win32::System::Threading::STARTUPINFOW = std::mem::zeroed();
        startup.cb = std::mem::size_of_val(&startup) as u32;
        startup.dwFlags = windows_sys::Win32::System::Threading::STARTF_USESTDHANDLES;
        startup.hStdInput = std::ptr::null_mut();
        startup.hStdOutput = stdout_write;
        startup.hStdError = stderr_write;
        let mut process_info: windows_sys::Win32::System::Threading::PROCESS_INFORMATION =
            std::mem::zeroed();
        let (application, mut command) = command_line(request);
        let cwd = wide(request.cwd.as_os_str());
        let environment = unicode_environment_block(&request.env);
        let created = windows_sys::Win32::System::Threading::CreateProcessW(
            application
                .as_ref()
                .map(|value| value.as_ptr())
                .unwrap_or(std::ptr::null()),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            windows_sys::Win32::System::Threading::CREATE_SUSPENDED
                | windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP
                | windows_sys::Win32::System::Threading::CREATE_UNICODE_ENVIRONMENT,
            environment.as_ptr().cast(),
            cwd.as_ptr(),
            &startup,
            &mut process_info,
        );
        close_handle(stdout_write);
        close_handle(stderr_write);
        if created == 0 {
            close_handle(job);
            close_handle(stdout_read);
            close_handle(stderr_read);
            return Err(spawn_error());
        }
        if windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(
            job,
            process_info.hProcess,
        ) == 0
        {
            windows_sys::Win32::System::Threading::TerminateProcess(process_info.hProcess, 1);
            close_handle(process_info.hProcess);
            close_handle(process_info.hThread);
            close_handle(job);
            close_handle(stdout_read);
            close_handle(stderr_read);
            return Err(spawn_error());
        }
        if windows_sys::Win32::System::Threading::ResumeThread(process_info.hThread) == u32::MAX {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(job, 1);
            close_handle(process_info.hProcess);
            close_handle(process_info.hThread);
            close_handle(job);
            close_handle(stdout_read);
            close_handle(stderr_read);
            return Err(spawn_error());
        }
        Ok(Spawned {
            process: process_info.hProcess,
            thread: process_info.hThread,
            job,
            pid: process_info.dwProcessId,
            stdout_read,
            stderr_read,
        })
    }
}

fn inheritable_pipe() -> Result<
    (
        windows_sys::Win32::Foundation::HANDLE,
        windows_sys::Win32::Foundation::HANDLE,
    ),
    ToolError,
> {
    unsafe {
        let mut read = std::ptr::null_mut();
        let mut write = std::ptr::null_mut();
        let mut security = windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>()
                as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        if windows_sys::Win32::System::Pipes::CreatePipe(&mut read, &mut write, &mut security, 0)
            == 0
        {
            return Err(spawn_error());
        }
        windows_sys::Win32::Foundation::SetHandleInformation(
            read,
            windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT,
            0,
        );
        Ok((read, write))
    }
}

async fn terminate_job(spawned: &Spawned, exit_code: u32) {
    unsafe {
        windows_sys::Win32::System::Console::GenerateConsoleCtrlEvent(
            windows_sys::Win32::System::Console::CTRL_BREAK_EVENT,
            spawned.pid,
        );
    }
    tokio::time::sleep(Duration::from_millis(1000)).await;
    unsafe {
        windows_sys::Win32::System::JobObjects::TerminateJobObject(spawned.job, exit_code);
    }
}

fn spawn_wait(process: SharedHandle) -> tokio::task::JoinHandle<Option<i32>> {
    tokio::task::spawn_blocking(move || unsafe {
        windows_sys::Win32::System::Threading::WaitForSingleObject(
            process.as_raw(),
            windows_sys::Win32::System::Threading::INFINITE,
        );
        let mut code = 0u32;
        windows_sys::Win32::System::Threading::GetExitCodeProcess(process.as_raw(), &mut code);
        Some(code as i32)
    })
}

async fn finish_pipe(
    task: &mut tokio::task::JoinHandle<(Vec<u8>, bool)>,
    spawned: &Spawned,
    output_limited: &mut bool,
) -> (Vec<u8>, bool) {
    match tokio::time::timeout(Duration::from_millis(1000), &mut *task).await {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => (Vec::new(), true),
        Err(_) => {
            *output_limited = true;
            terminate_job(spawned, 1).await;
            match tokio::time::timeout(Duration::from_millis(1000), &mut *task).await {
                Ok(Ok(value)) => value,
                _ => {
                    task.abort();
                    (Vec::new(), true)
                }
            }
        }
    }
}

fn read_pipe(handle: SharedHandle, limit: usize, hit_limit: &AtomicBool) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut truncated = false;
    let mut buf = [0u8; 8192];
    unsafe {
        loop {
            let mut read = 0u32;
            let ok = windows_sys::Win32::Storage::FileSystem::ReadFile(
                handle.as_raw(),
                buf.as_mut_ptr(),
                buf.len() as u32,
                &mut read,
                std::ptr::null_mut(),
            );
            if ok == 0 || read == 0 {
                break;
            }
            let room = limit.saturating_sub(out.len());
            if room == 0 {
                truncated = true;
                continue;
            }
            let take = (read as usize).min(room);
            out.extend_from_slice(&buf[..take]);
            if take < read as usize || room == 0 {
                truncated = true;
                hit_limit.store(true, Ordering::SeqCst);
            }
        }
        close_handle(handle.as_raw());
    }
    (out, truncated)
}

fn close_handle(handle: windows_sys::Win32::Foundation::HANDLE) {
    if !handle.is_null() {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
    }
}

fn spawn_error() -> ToolError {
    ToolError::new(
        ToolErrorCode::ToolProcessSpawnFailed,
        "process spawn failed",
    )
}

async fn wait_for_limit(hit: &AtomicBool) {
    while !hit.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn command_line(request: &SuperviseRequest) -> (Option<Vec<u16>>, Vec<u16>) {
    if let Some(argv) = request.argv.as_ref().filter(|argv| !argv.is_empty()) {
        return (Some(wide(&argv[0])), wide(&quote_windows_command(argv)));
    }
    (
        None,
        wide(&format!("{} /D /S /C {}", comspec(), request.command)),
    )
}

fn comspec() -> String {
    std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned())
}

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
