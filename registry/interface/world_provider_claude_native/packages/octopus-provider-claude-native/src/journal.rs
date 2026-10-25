use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const JOURNAL_FILE: &str = "claude-native-journal.json";
const JOURNAL_VERSION: u32 = 1;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RunSession {
    pub claude_session_id: String,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct JournalState {
    version: u32,
    runs: BTreeMap<String, RunSession>,
}

pub struct Journal {
    path: PathBuf,
    max_bytes: u64,
    state: JournalState,
}

impl Journal {
    pub fn open(var_dir: &Path, max_bytes: u64) -> Result<Self, String> {
        let path = var_dir.join(JOURNAL_FILE);
        let state = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.len() > max_bytes {
                    return Err("claude native journal is not a bounded regular file".into());
                }
                let state: JournalState = serde_json::from_slice(
                    &std::fs::read(&path).map_err(|error| format!("claude native journal is unreadable: {error}"))?,
                )
                .map_err(|error| format!("claude native journal is malformed: {error}"))?;
                if state.version != JOURNAL_VERSION {
                    return Err(format!("unsupported claude native journal version {}", state.version));
                }
                state
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => JournalState { version: JOURNAL_VERSION, runs: BTreeMap::new() },
            Err(error) => return Err(format!("claude native journal cannot be inspected: {error}")),
        };
        Ok(Self { path, max_bytes, state })
    }

    pub fn session(&self, run: &str) -> Option<&RunSession> {
        self.state.runs.get(run)
    }

    pub fn record_session(&mut self, run: &str, claude_session_id: &str) -> Result<(), String> {
        let entry = RunSession { claude_session_id: claude_session_id.to_string() };
        if self.state.runs.get(run) == Some(&entry) {
            return Ok(());
        }
        self.state.runs.insert(run.to_string(), entry);
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.state).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > self.max_bytes {
            return Err("claude native journal exceeds its declared limit".into());
        }
        let root = self.path.parent().ok_or("claude native journal has no directory")?;
        let next = root.join(format!("{JOURNAL_FILE}.next"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&next).map_err(|error| format!("claude native journal cannot be prepared: {error}"))?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("claude native journal cannot be persisted: {error}"))?;
        std::fs::rename(&next, &self.path).map_err(|error| format!("claude native journal cannot be installed: {error}"))?;
        std::fs::File::open(root)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("claude native journal directory cannot be synced: {error}"))
    }
}
