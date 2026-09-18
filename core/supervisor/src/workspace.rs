//! Ephemeral workspace management.
//!
//! Each job gets a private directory that is created, populated, handed to the
//! sandbox runner, and removed when the job's guard is dropped, including on
//! panic or early return.

use crate::protocol::SourceFile;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Owns a workspace directory and deletes it on drop.
pub struct Workspace {
    path: PathBuf,
    keep: bool,
}

impl Workspace {
    /// Create a fresh workspace under `root` and write `files` into it.
    pub fn create(root: &Path, job_id: &str, files: &[SourceFile]) -> io::Result<Self> {
        fs::create_dir_all(root)?;

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let safe_id: String = job_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(24)
            .collect();

        let path = root.join(format!("run_{safe_id}_{nanos:x}_{seq:x}"));
        fs::create_dir(&path)?;
        let workspace = Workspace { path, keep: false };

        // The runner's environment points HOME, TMPDIR and every toolchain cache
        // inside the workspace, so those directories must exist up front.
        fs::create_dir_all(workspace.path.join("tmp"))?;
        fs::create_dir_all(workspace.path.join(".cache"))?;

        for file in files {
            workspace.write_file(&file.name, &file.content)?;
        }
        Ok(workspace)
    }

    fn write_file(&self, name: &str, content: &str) -> io::Result<()> {
        let target = self.path.join(name);

        // Belt and braces: names were validated on the wire, but re-check that
        // the resolved parent is still inside the workspace before writing.
        let parent = target.parent().unwrap_or(&self.path);
        fs::create_dir_all(parent)?;
        let canonical_root = self.path.canonicalize()?;
        let canonical_parent = parent.canonicalize()?;
        if !canonical_parent.starts_with(&canonical_root) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("file '{name}' resolves outside the workspace"),
            ));
        }

        fs::write(&target, content)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Leave the directory in place for debugging.
    pub fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("codecraft_test_{nanos:x}"))
    }

    #[test]
    fn writes_files_and_removes_the_directory_on_drop() {
        let root = temp_root();
        let files = vec![
            SourceFile { name: "main.py".into(), content: "print(1)".into() },
            SourceFile { name: "pkg/util.py".into(), content: "X = 2".into() },
        ];
        let path = {
            let workspace = Workspace::create(&root, "job-1", &files).unwrap();
            let path = workspace.path().to_path_buf();
            assert_eq!(fs::read_to_string(path.join("main.py")).unwrap(), "print(1)");
            assert_eq!(fs::read_to_string(path.join("pkg/util.py")).unwrap(), "X = 2");
            assert!(path.join("tmp").is_dir());
            path
        };
        assert!(!path.exists(), "workspace should be removed on drop");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn each_workspace_gets_a_distinct_directory() {
        let root = temp_root();
        let files = vec![SourceFile { name: "m.py".into(), content: String::new() }];
        let a = Workspace::create(&root, "job", &files).unwrap();
        let b = Workspace::create(&root, "job", &files).unwrap();
        assert_ne!(a.path(), b.path());
        let _ = fs::remove_dir_all(&root);
    }
}
