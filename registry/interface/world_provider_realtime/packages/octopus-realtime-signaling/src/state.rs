use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TranscriptEntry {
    pub id: String,
    pub role: String,
    pub text: String,
    pub complete: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub digest: String,
    pub result: Option<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Call {
    pub correlation_id: String,
    pub offer_digest: String,
    pub call_id: Option<String>,
    pub source_seq: u64,
    pub delegation_interface: String,
    pub status: String,
    pub auth_owner: Option<String>,
    pub answer: Option<Value>,
    pub transcript: Vec<TranscriptEntry>,
    pub provider_events: BTreeSet<String>,
    pub delegations: BTreeSet<String>,
    pub updates: BTreeMap<String, Operation>,
    pub stops: BTreeMap<String, Operation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_context: Option<Vec<crate::ClientContextEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_configuration: Option<Value>,
    /// Whether the run authors a route that carries this call's final
    /// transcript to its delegation interface, and whether it was handed.
    #[serde(default)]
    pub hands_transcript: bool,
    #[serde(default)]
    pub transcript_handed: bool,
}

impl Call {
    pub fn remote_closed(&self) -> bool {
        let Some(call_id) = self.call_id.as_deref() else {
            return false;
        };
        self.status == "closed"
            || self.stops.values().any(|operation| {
                operation.result.as_ref().is_some_and(|body| {
                    body.get("remote_closed").and_then(Value::as_bool) == Some(true)
                        && body.get("call_id").and_then(Value::as_str) == Some(call_id)
                        && body.get("correlation_id").and_then(Value::as_str)
                            == Some(self.correlation_id.as_str())
                })
            })
    }

    pub fn transcript_bytes(&self) -> usize {
        self.transcript.iter().map(|entry| entry.text.len()).sum()
    }
    pub fn event_body(&self, mut body: Value) -> Value {
        body["correlation_id"] = Value::String(self.correlation_id.clone());
        body["call_id"] = self
            .call_id
            .as_ref()
            .map_or(Value::Null, |id| Value::String(id.clone()));
        body
    }
    pub fn delegation_body(&self, mut body: Value) -> Value {
        if let Some(context) = &self.client_context {
            body["client_context"] = serde_json::json!(context);
        }
        self.event_body(body)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PendingEmission {
    pub correlation_id: Option<String>,
    pub label: String,
    pub body: Value,
    pub delegated: bool,
    pub observation: bool,
    pub terminal: bool,
    pub source_seq: u64,
    pub destination: Option<String>,
    pub delivery: Option<DeliveryIdentity>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryIdentity {
    pub artifact: octopus_ledger::ArtifactRef,
    pub outbound: Vec<octopus_policy::AuthoredInterfaceBinding>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredState {
    pub version: u32,
    pub calls: BTreeMap<String, Call>,
    pub pending: Vec<PendingEmission>,
    pub next_emission_seq: u64,
    pub sources: BTreeMap<String, u64>,
}

pub struct Store {
    path: PathBuf,
    max_bytes: u64,
    pub state: StoredState,
}

impl Store {
    pub fn open(root: &Path, max_bytes: u64) -> Result<Self, String> {
        let path = root.join("voice-state.json");
        let state = match std::fs::metadata(&path) {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.len() > max_bytes {
                    return Err("realtime private state exceeds its declared boundary".into());
                }
                let bytes =
                    std::fs::read(&path).map_err(|_| "realtime private state is unreadable")?;
                let state: StoredState = serde_json::from_slice(&bytes)
                    .map_err(|_| "realtime private state is malformed")?;
                if state.version != 1 {
                    return Err("unsupported realtime private state version".into());
                }
                for call in state.calls.values() {
                    crate::client_context::validate(call.client_context.as_deref())?;
                }
                state
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => StoredState {
                version: 1,
                ..Default::default()
            },
            Err(_) => return Err("realtime private state cannot be inspected".into()),
        };
        Ok(Self {
            path,
            max_bytes,
            state,
        })
    }

    pub fn save(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.state)
            .map_err(|_| "realtime private state cannot serialize")?;
        if bytes.len() as u64 > self.max_bytes {
            return Err("realtime private state exceeds declared limit".into());
        }
        let root = self
            .path
            .parent()
            .ok_or("private state has no owner directory")?;
        std::fs::create_dir_all(root).map_err(|_| "realtime owner directory cannot be created")?;
        let next = root.join("voice-state.next");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&next)
            .map_err(|_| "realtime private state cannot be prepared")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "realtime private state cannot be persisted")?;
        std::fs::rename(&next, &self.path)
            .map_err(|_| "realtime private state cannot be installed")?;
        std::fs::File::open(root)
            .and_then(|file| file.sync_all())
            .map_err(|_| "realtime private state directory cannot be synced".to_string())
    }
}
