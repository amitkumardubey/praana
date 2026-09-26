//! Directory-handle file IO.
//!
//! A path checked earlier can be replaced by a symlink before the write.
//! Opens walk from the filesystem root with `O_NOFOLLOW` and create temps
//! with `O_EXCL` so a planted name cannot truncate a file outside the parent.

#[cfg(not(unix))]
use std::fs;
#[cfg(not(unix))]
use std::fs::File;
#[cfg(not(unix))]
use std::io::Write;
#[cfg(not(unix))]
use std::path::Component;
use std::path::Path;

use crate::tools::error::{ToolError, ToolErrorCode};

fn io(message: &str) -> ToolError {
    ToolError::new(ToolErrorCode::ToolIoFailed, message)
}

#[cfg(all(test, unix))]
thread_local! {
    static TEMP_MODE_BEFORE_WRITE: std::cell::Cell<u32> = const { std::cell::Cell::new(u32::MAX) };
}

#[cfg(all(test, unix))]
fn note_temp_mode(file: &std::fs::File) {
    use std::os::unix::fs::PermissionsExt;
    let mode = file
        .metadata()
        .map(|meta| meta.permissions().mode() & 0o777)
        .unwrap_or(0);
    TEMP_MODE_BEFORE_WRITE.with(|slot| slot.set(mode));
}

#[cfg(all(not(test), unix))]
fn note_temp_mode(_file: &std::fs::File) {}

#[cfg(not(unix))]
pub fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

pub fn ensure_dir(path: &Path) -> Result<(), ToolError> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        unix::ensure_dir(path)
    }
    #[cfg(not(unix))]
    {
        reject_symlink_walk(path)?;
        fs::create_dir_all(path).map_err(|_| io("create parents failed"))
    }
}

pub fn read_regular(path: &Path, limit: u64) -> Result<Vec<u8>, ToolError> {
    #[cfg(unix)]
    {
        unix::read_regular(path, limit)
    }
    #[cfg(not(unix))]
    {
        if is_symlink(path) {
            return Err(io("refusing to follow a symlink"));
        }
        let meta = fs::metadata(path)
            .map_err(|_| ToolError::new(ToolErrorCode::ToolPathNotFound, "path was not found"))?;
        if meta.is_dir() {
            return Err(ToolError::new(
                ToolErrorCode::ToolValidationFailed,
                "path is a directory",
            ));
        }
        if meta.len() > limit {
            return Err(ToolError::new(
                ToolErrorCode::ToolValidationFailed,
                "file exceeds 16 MiB",
            ));
        }
        fs::read(path).map_err(|_| io("read failed"))
    }
}

pub fn replace_file(path: &Path, bytes: &[u8]) -> Result<(), ToolError> {
    #[cfg(unix)]
    {
        unix::replace_file(path, bytes)
    }
    #[cfg(not(unix))]
    {
        replace_file_fallback(path, bytes)
    }
}

pub fn remove_regular(path: &Path) -> Result<(), ToolError> {
    #[cfg(unix)]
    {
        unix::remove_regular(path)
    }
    #[cfg(not(unix))]
    {
        if is_symlink(path) {
            return Err(io("refusing to follow a symlink"));
        }
        fs::remove_file(path).map_err(|_| io("remove failed"))
    }
}

#[cfg(not(unix))]
fn replace_file_fallback(path: &Path, bytes: &[u8]) -> Result<(), ToolError> {
    let parent = path.parent().ok_or_else(|| io("path has no parent"))?;
    reject_symlink_walk(parent)?;
    if is_symlink(path) {
        return Err(io("refusing to follow a symlink"));
    }
    ensure_dir(parent)?;
    let mode = fs::symlink_metadata(path)
        .ok()
        .filter(|meta| meta.is_file())
        .map(|meta| meta.permissions());
    let name = unpredictable_name()?;
    let tmp = parent.join(name);
    let write_tmp = || -> Result<(), ToolError> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|_| io("temp file create failed"))?;
        file.write_all(bytes).map_err(|_| io("temp write failed"))?;
        file.sync_all().map_err(|_| io("temp fsync failed"))?;
        if let Some(mode) = mode {
            fs::set_permissions(&tmp, mode).map_err(|_| io("preserving permissions failed"))?;
        }
        Ok(())
    };
    if let Err(error) = write_tmp() {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    if let Err(error) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        let _ = error;
        return Err(io("atomic rename failed"));
    }
    if let Ok(dir) = File::open(parent) {
        dir.sync_all().map_err(|_| io("directory fsync failed"))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn reject_symlink_walk(path: &Path) -> Result<(), ToolError> {
    let mut current = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::Prefix(_) => current.push(component),
            Component::Normal(name) => {
                current.push(name);
                if is_symlink(&current) {
                    return Err(io("refusing to follow a symlink"));
                }
            }
            _ => return Err(io("path is not confined")),
        }
    }
    Ok(())
}

fn unpredictable_name() -> Result<String, ToolError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| io("entropy failed"))?;
    let mut name = String::from(".praana-");
    for byte in bytes {
        name.push_str(&format!("{byte:02x}"));
    }
    name.push_str(".tmp");
    Ok(name)
}

#[cfg(unix)]
mod unix {
    use std::ffi::CString;
    use std::fs::File;
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Component, Path};

    use super::{io, unpredictable_name};
    use crate::tools::error::{ToolError, ToolErrorCode};

    const OPEN_DIR: i32 = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

    pub fn ensure_dir(path: &Path) -> Result<(), ToolError> {
        let _ = open_dir(path, true)?;
        Ok(())
    }

    pub fn read_regular(path: &Path, limit: u64) -> Result<Vec<u8>, ToolError> {
        let parent = path.parent().ok_or_else(|| io("path has no parent"))?;
        let name = path
            .file_name()
            .ok_or_else(|| io("path has no file name"))?;
        let dir = open_dir(parent, false)?;
        let fd = open_at(
            &dir,
            name,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0,
        )?;
        let mut file = unsafe { File::from_raw_fd(fd.as_raw_fd()) };
        std::mem::forget(fd);
        let meta = file.metadata().map_err(|_| io("read failed"))?;
        if meta.is_dir() {
            return Err(ToolError::new(
                ToolErrorCode::ToolValidationFailed,
                "path is a directory",
            ));
        }
        if meta.len() > limit {
            return Err(ToolError::new(
                ToolErrorCode::ToolValidationFailed,
                "file exceeds 16 MiB",
            ));
        }
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut bytes).map_err(|_| io("read failed"))?;
        Ok(bytes)
    }

    pub fn replace_file(path: &Path, bytes: &[u8]) -> Result<(), ToolError> {
        let parent = path.parent().ok_or_else(|| io("path has no parent"))?;
        let name = path
            .file_name()
            .ok_or_else(|| io("path has no file name"))?;
        let dir = open_dir(parent, false)?;
        let mode = match symlink_mode(&dir, name)? {
            Node::Symlink | Node::Other => return Err(io("refusing to follow a symlink")),
            Node::Directory => {
                return Err(ToolError::new(
                    ToolErrorCode::ToolValidationFailed,
                    "path is a directory",
                ))
            }
            Node::File(mode) => mode,
            Node::Missing => 0o644,
        };
        let (tmp_name, mut file) = create_temp(&dir)?;
        super::note_temp_mode(&file);
        let write_result = (|| -> Result<(), ToolError> {
            file.write_all(bytes).map_err(|_| io("temp write failed"))?;
            file.sync_all().map_err(|_| io("temp fsync failed"))?;
            let chmod = unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) };
            if chmod != 0 {
                return Err(io("preserving permissions failed"));
            }
            file.sync_all().map_err(|_| io("temp fsync failed"))?;
            Ok(())
        })();
        if let Err(error) = write_result {
            drop(file);
            let _ = unlink_at(&dir, &tmp_name);
            return Err(error);
        }
        drop(file);
        if let Err(error) = rename_at(&dir, &tmp_name, name) {
            let _ = unlink_at(&dir, &tmp_name);
            return Err(error);
        }
        let rc = unsafe { libc::fsync(dir.as_raw_fd()) };
        if rc != 0 {
            return Err(io("directory fsync failed"));
        }
        Ok(())
    }

    pub fn remove_regular(path: &Path) -> Result<(), ToolError> {
        let parent = path.parent().ok_or_else(|| io("path has no parent"))?;
        let name = path
            .file_name()
            .ok_or_else(|| io("path has no file name"))?;
        let dir = open_dir(parent, false)?;
        match symlink_mode(&dir, name)? {
            Node::File(_) => {}
            Node::Missing => return Ok(()),
            Node::Directory => {
                return Err(ToolError::new(
                    ToolErrorCode::ToolValidationFailed,
                    "path is a directory",
                ))
            }
            Node::Symlink | Node::Other => return Err(io("refusing to follow a symlink")),
        }
        unlink_name_at(&dir, name)
    }

    enum Node {
        Missing,
        File(u32),
        Directory,
        Symlink,
        Other,
    }

    fn symlink_mode(dir: &OwnedFd, name: &std::ffi::OsStr) -> Result<Node, ToolError> {
        let c_name = c_string(name)?;
        let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
        let rc = unsafe {
            libc::fstatat(
                dir.as_raw_fd(),
                c_name.as_ptr(),
                &mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::NotFound {
                return Ok(Node::Missing);
            }
            return Err(io("stat failed"));
        }
        let mode = stat.st_mode;
        if mode & libc::S_IFMT == libc::S_IFLNK {
            return Ok(Node::Symlink);
        }
        if mode & libc::S_IFMT == libc::S_IFDIR {
            return Ok(Node::Directory);
        }
        if mode & libc::S_IFMT == libc::S_IFREG {
            return Ok(Node::File(mode & 0o777));
        }
        Ok(Node::Other)
    }

    fn create_temp(dir: &OwnedFd) -> Result<(String, File), ToolError> {
        for _ in 0..8 {
            let name = unpredictable_name()?;
            match open_at(
                dir,
                std::ffi::OsStr::new(&name),
                libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_WRONLY | libc::O_CLOEXEC,
                0o600,
            ) {
                Ok(fd) => {
                    let raw = fd.as_raw_fd();
                    let chmod = unsafe { libc::fchmod(raw, 0o600) };
                    if chmod != 0 {
                        drop(fd);
                        let _ = unlink_at(dir, &name);
                        return Err(io("temp permissions failed"));
                    }
                    let file = unsafe { File::from_raw_fd(raw) };
                    std::mem::forget(fd);
                    return Ok((name, file));
                }
                Err(error) if error.message() == "already exists" => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io("temp file create failed"))
    }

    fn open_dir(path: &Path, create: bool) -> Result<OwnedFd, ToolError> {
        let mut fd = open_root()?;
        if path.as_os_str().is_empty() || path == Path::new("/") {
            return Ok(fd);
        }
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => {
                    fd = match open_at(&fd, name, OPEN_DIR, 0) {
                        Ok(next) => next,
                        Err(_) if create => {
                            mkdir_at(&fd, name)?;
                            open_at(&fd, name, OPEN_DIR, 0)?
                        }
                        Err(error) => return Err(error),
                    };
                }
                _ => return Err(io("path is not confined")),
            }
        }
        Ok(fd)
    }

    fn open_root() -> Result<OwnedFd, ToolError> {
        let fd = unsafe {
            libc::open(
                c"/".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        owned(fd, "open root failed")
    }

    fn open_at(
        dir: &OwnedFd,
        name: &std::ffi::OsStr,
        flags: i32,
        mode: i32,
    ) -> Result<OwnedFd, ToolError> {
        let c_name = c_string(name)?;
        let fd = unsafe { libc::openat(dir.as_raw_fd(), c_name.as_ptr(), flags, mode) };
        if fd < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::AlreadyExists {
                return Err(io("already exists"));
            }
            if err.raw_os_error() == Some(libc::ELOOP) {
                return Err(io("refusing to follow a symlink"));
            }
            if err.kind() == std::io::ErrorKind::NotFound {
                return Err(ToolError::new(
                    ToolErrorCode::ToolPathNotFound,
                    "path was not found",
                ));
            }
            return Err(io("open failed"));
        }
        owned(fd, "open failed")
    }

    fn mkdir_at(dir: &OwnedFd, name: &std::ffi::OsStr) -> Result<(), ToolError> {
        let c_name = c_string(name)?;
        let rc = unsafe { libc::mkdirat(dir.as_raw_fd(), c_name.as_ptr(), 0o755) };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::AlreadyExists {
                return Ok(());
            }
            return Err(io("create parents failed"));
        }
        Ok(())
    }

    fn rename_at(dir: &OwnedFd, from: &str, to: &std::ffi::OsStr) -> Result<(), ToolError> {
        let from = c_string(std::ffi::OsStr::new(from))?;
        let to = c_string(to)?;
        let rc =
            unsafe { libc::renameat(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr()) };
        if rc != 0 {
            return Err(io("atomic rename failed"));
        }
        Ok(())
    }

    fn unlink_at(dir: &OwnedFd, name: &str) -> Result<(), ()> {
        let c_name = CString::new(name).map_err(|_| ())?;
        let rc = unsafe { libc::unlinkat(dir.as_raw_fd(), c_name.as_ptr(), 0) };
        if rc == 0 {
            Ok(())
        } else {
            Err(())
        }
    }

    fn unlink_name_at(dir: &OwnedFd, name: &std::ffi::OsStr) -> Result<(), ToolError> {
        let name = c_string(name)?;
        let rc = unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) };
        if rc == 0 {
            Ok(())
        } else {
            Err(io("remove failed"))
        }
    }

    fn owned(fd: i32, message: &str) -> Result<OwnedFd, ToolError> {
        if fd < 0 {
            return Err(io(message));
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn c_string(name: &std::ffi::OsStr) -> Result<CString, ToolError> {
        CString::new(name.as_bytes()).map_err(|_| io("path contains NUL"))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::replace_file;

    #[test]
    fn symlink_parent_cannot_receive_a_missing_child() {
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().join("outside");
        let parent = root.path().join("parent");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, &parent).unwrap();
        let error = replace_file(&parent.join("child.txt"), b"nope");
        assert!(error.is_err(), "{error:?}");
        assert!(!outside.join("child.txt").exists());
    }

    #[test]
    fn temp_is_user_only_before_bytes_are_written() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("secret.txt");
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        replace_file(&path, b"secret-contents").unwrap();
        let during = super::TEMP_MODE_BEFORE_WRITE.with(|slot| slot.get());
        assert_eq!(during, 0o600);
        let final_mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(final_mode, 0o644);
        assert_eq!(std::fs::read(&path).unwrap(), b"secret-contents");
    }
}
