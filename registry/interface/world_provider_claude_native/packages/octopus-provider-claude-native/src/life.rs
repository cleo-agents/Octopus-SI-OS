use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use octopus_interface_transport::{InterfaceLifeFuture, InterfaceLiftContext, InterfaceLiftFn};
use octopus_interfaces::{InterfaceArtifactFile, InterfaceDescriptor, InterfaceInvocationEnvelope};
use octopus_run_authoring::{
    ProviderEmission, ProviderEmissionRoute, ProviderHandoffSession, ProviderOutputHandoff, ProviderSourceRecovery,
    RunAuthoringResultIdentity,
};
use octopus_world_pyecho_life_runtime::{LedgerTailReader, OwnOutboundMovement};
use serde_json::{Value, json};

use crate::child::{Event, ItemKind, SdkChild, SessionConfig, TextInput, TurnStatus, Usage};
use crate::config::{ClaudeNativeConfig, verify_sdk_child};
use crate::journal::Journal;

const REPLY_LABEL: &str = "interface.artifact.output";
const TURN_ERROR_LABEL: &str = "turn.error";
const AUTHENTICATION_FAILURE_CODE: &str = "provider.authentication.invalid";
const CHILD_ENVIRONMENT: [&str; 9] = ["HOME", "PATH", "USER", "LANG", "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
const TURN_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub fn interface_life() -> InterfaceLiftFn {
    Arc::new(|ctx| Box::pin(provider_life(ctx)) as InterfaceLifeFuture)
}

struct Provider {
    ctx: InterfaceLiftContext,
    descriptor: InterfaceDescriptor,
    config: ClaudeNativeConfig,
    session: ProviderHandoffSession,
    journal: Journal,
    child_executable: PathBuf,
    claude_cwd: PathBuf,
    child: Option<SdkChild>,
    open_sessions: BTreeMap<String, String>,
}

struct TurnReply {
    text: String,
    claude_session_id: Option<String>,
    usage: Option<Usage>,
}

struct TurnFailure {
    code: String,
    message: String,
}

impl TurnFailure {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

async fn provider_life(ctx: InterfaceLiftContext) -> Result<(), String> {
    let descriptor = ctx.resolved_interface_descriptor()?;
    let config = ClaudeNativeConfig::from_descriptor(&descriptor)?;
    let registry_interface_root = ctx.root_slot("registry_interface_root").map_err(|error| error.to_string())?.to_path_buf();
    let child_executable = config.sdk_child_executable(&registry_interface_root)?;
    verify_sdk_child(&child_executable)?;
    let authoring_results = RunAuthoringResultIdentity::from_descriptor(&descriptor)?;
    let session = ProviderHandoffSession::new(&ctx)?;
    let mut reader = LedgerTailReader::open(&ctx)?;
    let journal = Journal::open(&ctx.var_dir, ctx.required_host_io_limits()?.max_payload_bytes)?;
    let claude_cwd = ctx.var_dir.join("claude-cwd");
    std::fs::create_dir_all(&claude_cwd).map_err(|error| format!("claude working directory cannot be created: {error}"))?;
    let mut provider = Provider {
        ctx: ctx.clone(),
        descriptor,
        config,
        session,
        journal,
        child_executable,
        claude_cwd,
        child: None,
        open_sessions: BTreeMap::new(),
    };
    ctx.signal_ready().await?;
    loop {
        if ctx.cancel.is_cancelled() {
            provider.shutdown().await;
            return Ok(());
        }
        for own in reader.read_new()? {
            if ctx.cancel.is_cancelled() {
                break;
            }
            let envelope = match reader.envelope(&own) {
                Ok(envelope) => envelope,
                Err(error) => {
                    ctx.hand_admitted_failure(own.movement.seq.0, "poisoned_provider_outbound", json!({"error": error})).await?;
                    reader.commit_through(&own)?;
                    continue;
                }
            };
            let manifest = envelope.read_artifact_manifest().map_err(|error| error.to_string())?;
            if authoring_results.consume_if_matches(&ctx, &own.movement, &envelope, &manifest.label).await? {
                reader.commit_through(&own)?;
                continue;
            }
            provider.process(&own, &envelope, &manifest.label).await?;
            reader.commit_through(&own)?;
        }
        tokio::select! {
            _ = ctx.cancel.cancelled() => {}
            result = reader.wait_for_change(&ctx.cancel) => result?,
        }
    }
}

impl Provider {
    async fn process(&mut self, own: &OwnOutboundMovement, envelope: &InterfaceInvocationEnvelope, label: &str) -> Result<(), String> {
        let seq = own.movement.seq.0;
        let runtime = envelope.runtime().map_err(|error| error.to_string())?;
        let run = runtime.run.as_str().to_string();
        let pinned = self.ctx.pinned_run_record_bytes(envelope)?;
        let handoff = self
            .session
            .from_invocation_when_ready(&self.ctx, &self.descriptor, &runtime.run, envelope, seq, &pinned)
            .await
            .map_err(Into::<String>::into)?;
        let (recovery, _) = handoff.recover_source_with_outcomes().await?;
        match recovery {
            ProviderSourceRecovery::Completed => return Ok(()),
            ProviderSourceRecovery::Process => {}
            ProviderSourceRecovery::Interrupted { last_artifact_label } => {
                let failure = TurnFailure::new(
                    "transport_turn_interrupted",
                    format!("the provider restarted after handing '{last_artifact_label}'; the model call was not replayed"),
                );
                return self.hand_failure(&handoff, &failure).await;
            }
            ProviderSourceRecovery::Bridged { invocation_movement_seq } => {
                let failure = TurnFailure::new(
                    "bridged_source_unsupported",
                    format!("source {seq} is bridged to invocation {invocation_movement_seq}, which this provider does not continue"),
                );
                return self.hand_failure(&handoff, &failure).await;
            }
        }
        let Some(input) = self.config.input_messages.get(label).cloned() else {
            let failure = TurnFailure::new("input_not_supported", format!("this provider does not accept '{label}' artifacts"));
            return self.hand_failure(&handoff, &failure).await;
        };
        let resume = self.journal.session(&run).map(|entry| entry.claude_session_id.clone());
        let history = handoff.current_session_context_artifacts().await;
        let selection = self.config.instruction_selection()?;
        let context = match crate::context::assemble(envelope, &pinned, &input, &selection, &history, resume.is_none()) {
            Ok(context) => context,
            Err(error) => return self.hand_failure(&handoff, &TurnFailure::new("context_unavailable", error)).await,
        };
        let turn = format!("source-{seq}");
        match self.run_turn(&run, &turn, resume, context).await {
            Ok(reply) => {
                if let Some(claude) = &reply.claude_session_id {
                    self.journal.record_session(&run, claude)?;
                }
                self.hand_reply(&handoff, &turn, reply).await
            }
            Err(failure) => self.hand_failure(&handoff, &failure).await,
        }
    }

    async fn run_turn(
        &mut self,
        run: &str,
        turn: &str,
        resume: Option<String>,
        context: crate::context::TurnContext,
    ) -> Result<TurnReply, TurnFailure> {
        let session = session_name(run);
        self.ensure_child().await?;
        let fingerprint = context.system_fingerprint();
        let resume = match self.open_sessions.get(&session) {
            Some(open) if *open == fingerprint => None,
            Some(_) => {
                let _ = self.child_mut()?.close(&session).await;
                self.open_sessions.remove(&session);
                resume
            }
            None => resume,
        };
        if !self.open_sessions.contains_key(&session) {
            let config = SessionConfig {
                model: self.config.model.clone(),
                system_prompt: context.system_prompt.clone(),
                cwd: self.claude_cwd.display().to_string(),
                effort: Some(self.config.reasoning_effort.clone()),
                resume,
                max_turns: None,
                tools: Vec::new(),
            };
            self.child_mut()?.start(&session, config).await.map_err(|error| self.child_failed(error))?;
            self.open_sessions.insert(session.clone(), fingerprint);
        }
        let child = self.child_mut()?;
        child
            .turn(&session, turn, vec![TextInput::new(context.prompt)])
            .await
            .map_err(|error| TurnFailure::new(&error.code, error.message))?;
        let mut text = Vec::new();
        let mut usage = None;
        let mut failure: Option<TurnFailure> = None;
        let mut claude_session_id = None;
        let deadline = tokio::time::Instant::now() + TURN_TIMEOUT;
        loop {
            let event = match tokio::time::timeout_at(deadline, self.child_mut()?.next_event()).await {
                Ok(Some(event)) => event,
                Ok(None) => return Err(self.child_lost("the SDK child closed its event stream")),
                Err(_) => {
                    let _ = self.child_mut()?.interrupt(&session, turn).await;
                    return Err(TurnFailure::new("turn_timeout", "the Claude turn exceeded its time limit and was interrupted"));
                }
            };
            match event {
                Event::Session { session: name, claude_session_id: id, .. } if name == session => claude_session_id = Some(id),
                Event::Item { session: name, turn: t, item } if name == session && t == turn => {
                    if item.kind == ItemKind::Text {
                        text.push(item.text);
                    }
                }
                Event::Usage { session: name, turn: t, usage: observed, .. } if name == session && t == turn => usage = Some(observed),
                Event::Error { fatal: true, code, message, .. } => {
                    self.child = None;
                    self.open_sessions.clear();
                    return Err(TurnFailure::new(&code, message));
                }
                Event::Error { session: Some(name), code, message, .. } if name == session => {
                    failure.get_or_insert(TurnFailure::new(&code, message));
                }
                Event::TurnEnd { session: name, turn: t, status, result, claude_session_id: id } if name == session && t == turn => {
                    if id.is_some() {
                        claude_session_id = id;
                    }
                    return match status {
                        TurnStatus::Completed => {
                            let text = if text.is_empty() { result.unwrap_or_default() } else { text.join("\n\n") };
                            if text.trim().is_empty() {
                                Err(TurnFailure::new("empty_reply", "Claude Code completed the turn without text"))
                            } else {
                                Ok(TurnReply { text, claude_session_id, usage })
                            }
                        }
                        TurnStatus::Interrupted => Err(TurnFailure::new("turn_interrupted", "the Claude turn was interrupted")),
                        TurnStatus::Failed => {
                            self.open_sessions.remove(&session);
                            Err(failure.unwrap_or_else(|| TurnFailure::new("claude_turn_failed", "the Claude turn failed")))
                        }
                    };
                }
                _ => {}
            }
        }
    }

    async fn ensure_child(&mut self) -> Result<(), TurnFailure> {
        if self.child.is_some() {
            return Ok(());
        }
        let environment = CHILD_ENVIRONMENT
            .iter()
            .filter_map(|name| std::env::var_os(name).map(|value| (OsString::from(*name), value)))
            .collect::<Vec<_>>();
        let child = SdkChild::spawn(
            &self.child_executable,
            &self.config.sdk_child.claude_executable,
            environment,
            &self.claude_cwd,
        )
        .await
        .map_err(|error| TurnFailure::new(&error.code, error.message))?;
        self.child = Some(child);
        self.open_sessions.clear();
        Ok(())
    }

    fn child_mut(&mut self) -> Result<&mut SdkChild, TurnFailure> {
        self.child.as_mut().ok_or_else(|| TurnFailure::new("child_unavailable", "the SDK child is not running"))
    }

    fn child_failed(&mut self, error: crate::child::ChildError) -> TurnFailure {
        if matches!(error.code.as_str(), "child_exited" | "child_write_failed" | "child_failed" | "child_protocol_violation") {
            self.child = None;
            self.open_sessions.clear();
        }
        TurnFailure::new(&error.code, error.message)
    }

    fn child_lost(&mut self, message: &str) -> TurnFailure {
        self.child = None;
        self.open_sessions.clear();
        TurnFailure::new("child_exited", message)
    }

    async fn hand_reply(&self, handoff: &ProviderOutputHandoff, turn: &str, reply: TurnReply) -> Result<(), String> {
        let mut value = json!({
            "thread_id": reply.claude_session_id,
            "turn_id": turn,
            "item_id": format!("msg_{turn}"),
            "text": reply.text,
            "phase": "final_answer",
            "lifecycle": "completed",
        });
        if let Some(usage) = reply.usage {
            value["provider_token_usage"] = json!({
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "cached_input_tokens": usage.cache_read_input_tokens,
                "cache_creation_input_tokens": usage.cache_creation_input_tokens,
            });
        }
        self.hand_terminal(handoff, REPLY_LABEL, &value).await
    }

    async fn hand_failure(&self, handoff: &ProviderOutputHandoff, failure: &TurnFailure) -> Result<(), String> {
        let mut value = json!({
            "message": failure.message,
            "will_retry": false,
            "additional_details": {"code": failure.code},
        });
        if failure.code == "claude_authentication_failed" {
            value["failure_code"] = Value::String(AUTHENTICATION_FAILURE_CODE.into());
        }
        self.hand_terminal(handoff, TURN_ERROR_LABEL, &value).await
    }

    async fn hand_terminal(&self, handoff: &ProviderOutputHandoff, label: &str, value: &Value) -> Result<(), String> {
        let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        let artifact = InterfaceArtifactFile::write(self.ctx.var_dir.join("emitted"), label, &bytes).map_err(|error| error.to_string())?;
        handoff
            .hand_final(ProviderEmission { artifact, route: ProviderEmissionRoute::ClientProjection })
            .await
            .map(|_| ())
    }

    async fn shutdown(&mut self) {
        if let Some(child) = self.child.take() {
            let _ = child.shutdown().await;
        }
    }
}

fn session_name(run: &str) -> String {
    let digest = blake3::hash(run.as_bytes()).to_hex();
    format!("run-{}", &digest[..32])
}
