use std::collections::BTreeSet;

use octopus_interface_transport::InterfaceLiftContext;
use octopus_interfaces::{
    InterfaceArtifactFile, InterfaceInvocationEnvelope, InterfaceTransportConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

mod auth;
mod client_context;
mod handoff;
mod life;
mod protocol;
mod state;
mod wire;

pub use life::interface_life;
pub use client_context::ClientContextEntry;

pub const REALTIME_SIGNALING_INTERFACE_DRIVER_REF: &str = "realtime_webrtc";
pub const SESSION_OFFER_LABEL: &str = "realtime.session.offer";
pub const SESSION_ANSWER_LABEL: &str = "realtime.session.answer";
pub const SESSION_UPDATE_LABEL: &str = "realtime.session.update";
pub const SESSION_STOP_LABEL: &str = "realtime.session.stop";
pub const SESSION_RECORDING_LABEL: &str = "realtime.session.recording";
pub const CALL_TRANSCRIPT_LABEL: &str = "realtime.call.transcript";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveProtocol {
    CodexLive,
    OpenaiLive,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RealtimeConfig {
    pub model: String,
    pub protocol: LiveProtocol,
    pub sideband_url: String,
    pub auth: auth::AuthConfig,
    pub session: Value,
    pub reconnect_attempts: u32,
    pub max_transcript_bytes: usize,
    pub run_authoring_profile: octopus_run_authoring::RunAuthoringProfile,
    pub model_hidden_tools: Vec<String>,
    pub context_output_labels: Vec<String>,
    pub session_snapshot_labels: Vec<String>,
    #[serde(default)]
    pub model_catalog: Vec<Value>,
}

#[derive(Clone)]
pub struct RealtimeDoorConfig {
    pub transport: InterfaceTransportConfig,
    pub private: RealtimeConfig,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionOffer {
    pub offer_sdp: String,
    pub correlation_id: String,
    pub delegation_interface: String,
    pub session: Value,
    #[serde(default)]
    pub client_context: Option<Vec<ClientContextEntry>>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionUpdate {
    pub call_id: String,
    pub correlation_id: String,
    pub update_id: String,
    pub delegation_id: Option<String>,
    pub channel: UpdateChannel,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub client_context: Option<Vec<ClientContextEntry>>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpdateChannel {
    Context,
    Commentary,
    Instructions,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionStop {
    pub call_id: String,
    pub correlation_id: String,
    pub stop_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRecording {
    pub schema: String,
    pub schema_version: u32,
    pub correlation_id: String,
    pub started_at: String,
    pub media: RecordingMedia,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordingMedia {
    pub path: String,
    pub mime_type: String,
    pub content_hash: String,
    pub size: u64,
}

pub fn merge_session(defaults: &Value, offered: &Value, model: &str) -> Result<Value, String> {
    let mut merged = defaults
        .as_object()
        .ok_or("declared session must be an object")?
        .clone();
    let overrides = offered
        .as_object()
        .ok_or("offer session must be an object")?;
    for (key, value) in overrides {
        if !matches!(key.as_str(), "instructions" | "initial_items" | "audio") {
            return Err(format!("offer session may not override '{key}'"));
        }
        merged.insert(key.clone(), value.clone());
    }
    for key in merged.keys() {
        if !matches!(
            key.as_str(),
            "instructions" | "initial_items" | "audio" | "delegation"
        ) {
            return Err(format!("unsupported declared session field '{key}'"));
        }
    }
    if !merged.get("instructions").is_some_and(Value::is_string) {
        return Err("session instructions must be a string".into());
    }
    if let Some(items) = merged.get("initial_items") {
        let items = items.as_array().ok_or("initial_items must be an array")?;
        for item in items {
            let object = item
                .as_object()
                .ok_or("initial_items entry must be an object")?;
            if object
                .keys()
                .any(|key| !matches!(key.as_str(), "type" | "role" | "content"))
                || item.get("type").and_then(Value::as_str) != Some("message")
                || !matches!(
                    item.get("role").and_then(Value::as_str),
                    Some("developer" | "user" | "assistant")
                )
            {
                return Err("initial_items must contain explicit text messages".into());
            }
            for content in item
                .get("content")
                .and_then(Value::as_array)
                .ok_or("initial_items content must be an array")?
            {
                if content.as_object().is_none_or(|object| {
                    object
                        .keys()
                        .any(|key| !matches!(key.as_str(), "type" | "text"))
                }) || !matches!(
                    content.get("type").and_then(Value::as_str),
                    Some("input_text" | "output_text")
                ) || !content.get("text").is_some_and(Value::is_string)
                {
                    return Err("initial_items must contain text content".into());
                }
            }
        }
    }
    let audio = merged
        .get("audio")
        .and_then(Value::as_object)
        .ok_or("session audio is required")?;
    if audio.len() != 1
        || audio
            .get("output")
            .and_then(Value::as_object)
            .is_none_or(|output| {
                output.len() != 1
                    || output
                        .get("voice")
                        .and_then(Value::as_str)
                        .is_none_or(|voice| voice.trim().is_empty())
            })
    {
        return Err("session audio must declare only output.voice".into());
    }
    if merged
        .get("delegation")
        .is_some_and(|value| value != &json!({"type":"client"}))
    {
        return Err(
            "only client delegation is supported; execution belongs to bound Octopus runs".into(),
        );
    }
    merged.insert("delegation".into(), json!({"type":"client"}));
    merged.insert("model".into(), json!(model));
    Ok(Value::Object(merged))
}

fn formed_provider_model(
    config: &RealtimeDoorConfig,
    envelope: &InterfaceInvocationEnvelope,
) -> Result<(), String> {
    let policy = envelope
        .interface_policy()
        .map_err(|error| error.to_string())?
        .ok_or("realtime invocation carries no formed interface policy")?;
    let values = policy
        .get("models")
        .and_then(Value::as_array)
        .ok_or("realtime formed interface policy models must be a string array")?;
    let mut models = BTreeSet::new();
    for value in values {
        let model = value
            .as_str()
            .ok_or("formed models contains a non-string")?;
        validate_identity(model, "formed model")?;
        if !models.insert(model) {
            return Err("formed models repeats a model".into());
        }
    }
    if !models.contains(config.private.model.as_str()) {
        return Err("selected model is outside formed interface policy models".into());
    }
    Ok(())
}

fn load_door_config(ctx: &InterfaceLiftContext) -> Result<RealtimeDoorConfig, String> {
    let descriptor = ctx.resolved_interface_descriptor()?;
    let driver = descriptor
        .interface_driver_config
        .ok_or("realtime interface has no driver config")?;
    let transport = driver
        .transport
        .ok_or("realtime interface has no interface_driver_config.transport")?;
    let private: RealtimeConfig = serde_json::from_value(json!(driver.private_config))
        .map_err(|error| format!("invalid realtime private config: {error}"))?;
    validate_identity(&private.model, "selected model")?;
    if transport.wire.as_deref() != Some("live_webrtc") {
        return Err("realtime transport must explicitly declare wire=live_webrtc".into());
    }
    if private.reconnect_attempts > 32
        || !(1024..=16_777_216).contains(&private.max_transcript_bytes)
    {
        return Err("realtime reconnect or transcript limit is outside supported bounds".into());
    }
    merge_session(&private.session, &json!({}), &private.model)?;
    wire::validate_endpoint(&transport.base_url, false)?;
    wire::validate_endpoint(&private.sideband_url, true)?;
    Ok(RealtimeDoorConfig { transport, private })
}

pub fn validate_identity(value: &str, name: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(format!("invalid {name}"));
    }
    Ok(())
}

fn materialize_emitted_artifact(
    root: &std::path::Path,
    label: &str,
    body: &Value,
) -> Result<InterfaceArtifactFile, String> {
    let bytes = serde_json::to_vec(body).map_err(|error| error.to_string())?;
    InterfaceArtifactFile::write(root.join("emitted"), label, &bytes)
        .map_err(|error| error.to_string())
}
