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
use crate::stream::LiveTurn;

const REPLY_LABEL: &str = "interface.artifact.output";
const TURN_ERROR_LABEL: &str = "turn.error";
const TOOL_CALL_LABEL: &str = "tool.call";
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
    streams_root: PathBuf,
    provider_interface: String,
    child: Option<SdkChild>,
    open_sessions: BTreeMap<String, OpenSession>,
    pending_calls: BTreeMap<String, PendingCall>,
}

struct OpenSession {
    fingerprint: String,
    tools: BTreeMap<String, String>,
}

struct PendingCall {
    reply_to: Option<Value>,
    run: String,
    session: String,
    turn: String,
    tool: String,
    live: LiveTurn,
}

enum TurnOutcome {
    Reply(TurnReply),
    ToolCall { call_id: String, tool: String, arguments: Value, claude_session_id: Option<String> },
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
    crate::config::verify_claude_grant(&ctx.interface_dir, &config.sdk_child.claude_executable)?;
    let registry_interface_root = ctx.root_slot("registry_interface_root").map_err(|error| error.to_string())?.to_path_buf();
    let child_executable = config.sdk_child_executable(&registry_interface_root)?;
    verify_sdk_child(&child_executable)?;
    let authoring_results = RunAuthoringResultIdentity::from_descriptor(&descriptor)?;
    let session = ProviderHandoffSession::new(&ctx)?;
    let mut reader = LedgerTailReader::open(&ctx)?;
    let journal = Journal::open(&ctx.var_dir, ctx.required_host_io_limits()?.max_payload_bytes)?;
    let claude_cwd = ctx.var_dir.join("claude-cwd");
    std::fs::create_dir_all(&claude_cwd).map_err(|error| format!("claude working directory cannot be created: {error}"))?;
    let streams_root = ctx.var_dir.join("streams");
    crate::stream::retire_open_streams(&streams_root)?;
    let provider_interface = descriptor.id.as_str().to_string();
    let mut provider = Provider {
        ctx: ctx.clone(),
        descriptor,
        config,
        session,
        journal,
        child_executable,
        claude_cwd,
        streams_root,
        provider_interface,
        child: None,
        open_sessions: BTreeMap::new(),
        pending_calls: BTreeMap::new(),
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
        let declared = self.config.input_messages.get(label).cloned();
        let reply_to = match declared {
            Some(_) => Some(serde_json::to_value(&envelope.artifact).map_err(|error| error.to_string())?),
            None => None,
        };
        let reply_to = reply_to.as_ref();
        match recovery {
            ProviderSourceRecovery::Completed => return Ok(()),
            ProviderSourceRecovery::Process => {}
            ProviderSourceRecovery::Interrupted { last_artifact_label } => {
                let failure = TurnFailure::new(
                    "transport_turn_interrupted",
                    format!("the provider restarted after handing '{last_artifact_label}'; the model call was not replayed"),
                );
                return self.hand_failure(&handoff, reply_to, None, &failure).await;
            }
            ProviderSourceRecovery::Bridged { invocation_movement_seq } => {
                let failure = TurnFailure::new(
                    "bridged_source_unsupported",
                    format!("source {seq} is bridged to invocation {invocation_movement_seq}, which this provider does not continue"),
                );
                return self.hand_failure(&handoff, reply_to, None, &failure).await;
            }
        }
        if let Some(input) = declared {
            return self.begin_turn(&handoff, envelope, &pinned, &run, seq, label, &input, reply_to).await;
        }
        let payload: Value = match envelope
            .read_artifact_payload()
            .map_err(|error| error.to_string())
            .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|error| error.to_string()))
        {
            Ok(payload) => payload,
            Err(error) => {
                return self.hand_failure(&handoff, None, None, &TurnFailure::new("input_unreadable", error)).await;
            }
        };
        match crate::tools::decode_tool_result(&payload) {
            Ok(Some(result)) => self.continue_after_result(&handoff, seq, label, result).await,
            Ok(None) => {
                let failure = TurnFailure::new("input_not_supported", format!("this provider does not accept '{label}' artifacts"));
                self.hand_failure(&handoff, None, None, &failure).await
            }
            Err(error) => self.hand_failure(&handoff, None, None, &TurnFailure::new("tool_result_malformed", error)).await,
        }
    }

    async fn begin_turn(
        &mut self,
        handoff: &ProviderOutputHandoff,
        envelope: &InterfaceInvocationEnvelope,
        pinned: &[u8],
        run: &str,
        seq: u64,
        label: &str,
        input: &crate::config::InputMessage,
        reply_to: Option<&Value>,
    ) -> Result<(), String> {
        let resume = self.journal.session(run).map(|entry| entry.claude_session_id.clone());
        let history = handoff.current_session_context_artifacts().await;
        let selection = self.config.instruction_selection()?;
        let context = match crate::context::assemble(envelope, pinned, label, input, &selection, &history, resume.is_none()) {
            Ok(context) => context,
            Err(error) => return self.hand_failure(handoff, reply_to, None, &TurnFailure::new("context_unavailable", error)).await,
        };
        let catalog = match crate::tools::admitted_catalog(handoff, envelope, &self.config.model_hidden_tools) {
            Ok(catalog) => catalog,
            Err(error) => return self.hand_failure(handoff, reply_to, None, &TurnFailure::new("tool_catalog_invalid", error)).await,
        };
        let session = session_name(run);
        let turn = format!("source-{seq}");
        let mut live = LiveTurn::new(self.streams_root.clone(), &self.provider_interface, run, &session, &turn, seq);
        let outcome = match self.start_turn(&session, &turn, resume, context, catalog).await {
            Ok(()) => self.drain(&session, &turn, &mut live).await,
            Err(failure) => Err(failure),
        };
        self.finish(handoff, reply_to, run, &session, &turn, live, outcome).await
    }

    async fn continue_after_result(
        &mut self,
        handoff: &ProviderOutputHandoff,
        seq: u64,
        label: &str,
        result: octopus_tool_handlers::ToolResultArtifact,
    ) -> Result<(), String> {
        let Some(call_id) = result.correlation_id.clone() else {
            return self.hand_failure(handoff, None, None, &TurnFailure::new("tool_result_uncorrelated", "the tool result carries no correlation_id")).await;
        };
        let Some(mut pending) = self.pending_calls.remove(&call_id) else {
            let failure = TurnFailure::new(
                "tool_result_not_pending",
                format!("tool result for call '{call_id}' arrived, but this provider holds no open Claude turn for it; the model call was not replayed"),
            );
            return self.hand_failure(handoff, None, None, &failure).await;
        };
        if result.tool != pending.tool || result.label != label {
            let failure = TurnFailure::new(
                "tool_result_mismatch",
                format!("call '{call_id}' was for tool '{}', the result names tool '{}' with label '{}'", pending.tool, result.tool, result.label),
            );
            let _ = self.answer_refused_call(&pending.session, &pending.turn, &call_id).await;
            return self.hand_failure(handoff, pending.reply_to.as_ref(), Some(pending.live), &failure).await;
        }
        let text = crate::tools::model_result_text(&result);
        let answered = match self.child_mut() {
            Ok(child) => child
                .tool_result(&pending.session, &pending.turn, &call_id, vec![TextInput::new(text)], !result.ok)
                .await
                .map_err(|error| TurnFailure::new(&error.code, error.message)),
            Err(failure) => Err(failure),
        };
        pending.live.source_movement_seq = seq;
        let outcome = match answered {
            Ok(()) => self.drain(&pending.session, &pending.turn, &mut pending.live).await,
            Err(failure) => Err(failure),
        };
        self.finish(handoff, pending.reply_to.as_ref(), &pending.run, &pending.session, &pending.turn, pending.live, outcome).await
    }

    async fn finish(
        &mut self,
        handoff: &ProviderOutputHandoff,
        reply_to: Option<&Value>,
        run: &str,
        session: &str,
        turn: &str,
        mut live: LiveTurn,
        outcome: Result<TurnOutcome, TurnFailure>,
    ) -> Result<(), String> {
        match outcome {
            Ok(TurnOutcome::Reply(reply)) => {
                if let Some(claude) = &reply.claude_session_id {
                    self.journal.record_session(run, claude)?;
                }
                self.hand_reply(handoff, reply_to, live, turn, reply).await
            }
            Ok(TurnOutcome::ToolCall { call_id, tool, arguments, claude_session_id }) => {
                if let Some(claude) = &claude_session_id {
                    self.journal.record_session(run, claude)?;
                }
                match self.hand_tool_call(handoff, &tool, &arguments, &call_id, &mut live).await {
                    Ok(true) => {
                        self.pending_calls.insert(
                            call_id,
                            PendingCall { reply_to: reply_to.cloned(), run: run.to_string(), session: session.to_string(), turn: turn.to_string(), tool, live },
                        );
                        Ok(())
                    }
                    Ok(false) => {
                        let _ = self.answer_refused_call(session, turn, &call_id).await;
                        live.abandon()
                    }
                    Err(error) => {
                        let _ = self.answer_refused_call(session, turn, &call_id).await;
                        let _ = live.abandon();
                        Err(error)
                    }
                }
            }
            Err(failure) => self.hand_failure(handoff, reply_to, Some(live), &failure).await,
        }
    }

    async fn answer_refused_call(&mut self, session: &str, turn: &str, call_id: &str) -> Result<(), TurnFailure> {
        let child = self.child_mut()?;
        child
            .tool_result(session, turn, call_id, vec![TextInput::new("Octopus did not admit this tool call.")], true)
            .await
            .map_err(|error| TurnFailure::new(&error.code, error.message))?;
        child.interrupt(session, turn).await.map_err(|error| TurnFailure::new(&error.code, error.message))
    }

    async fn start_turn(
        &mut self,
        session: &str,
        turn: &str,
        resume: Option<String>,
        context: crate::context::TurnContext,
        catalog: crate::tools::ToolCatalog,
    ) -> Result<(), TurnFailure> {
        self.ensure_child().await?;
        let fingerprint = format!("{}:{}", context.system_fingerprint(), blake3::hash(catalog.fingerprint_material().as_bytes()).to_hex());
        let resume = match self.open_sessions.get(session) {
            Some(open) if open.fingerprint == fingerprint => None,
            Some(_) => {
                let _ = self.child_mut()?.close(session).await;
                self.open_sessions.remove(session);
                resume
            }
            None => resume,
        };
        if !self.open_sessions.contains_key(session) {
            let config = SessionConfig {
                model: self.config.model.clone(),
                system_prompt: context.system_prompt.clone(),
                cwd: self.claude_cwd.display().to_string(),
                effort: Some(self.config.reasoning_effort.clone()),
                resume,
                max_turns: None,
                tools: catalog.specs.clone(),
            };
            self.child_mut()?.start(session, config).await.map_err(|error| self.child_failed(error))?;
            self.open_sessions.insert(session.to_string(), OpenSession { fingerprint, tools: catalog.tools_by_model_name });
        }
        self.child_mut()?
            .turn(session, turn, vec![TextInput::new(context.prompt)])
            .await
            .map_err(|error| TurnFailure::new(&error.code, error.message))
    }

    async fn drain(&mut self, session: &str, turn: &str, live: &mut LiveTurn) -> Result<TurnOutcome, TurnFailure> {
        let mut text = Vec::new();
        let mut usage = None;
        let mut failure: Option<TurnFailure> = None;
        let mut claude_session_id = None;
        let deadline = tokio::time::Instant::now() + TURN_TIMEOUT;
        let stream_failed = |error: String| TurnFailure::new("turn_stream_failed", error);
        loop {
            let wake = live.flush_due().map_or(deadline, |due| due.min(deadline));
            let event = match tokio::time::timeout_at(wake, self.child_mut()?.next_event()).await {
                Ok(Some(event)) => event,
                Ok(None) => return Err(self.child_lost("the SDK child closed its event stream")),
                Err(_) if wake < deadline => {
                    live.flush().map_err(stream_failed)?;
                    continue;
                }
                Err(_) => {
                    let _ = self.child_mut()?.interrupt(session, turn).await;
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
                Event::TextDelta { session: name, turn: t, message_id, text } if name == session && t == turn => {
                    if let Err(error) = live.delta(&message_id, &text) {
                        let _ = self.child_mut()?.interrupt(session, turn).await;
                        return Err(stream_failed(error));
                    }
                }
                Event::ToolCall { session: name, turn: t, call_id, name: model_name, input } if name == session && t == turn => {
                    let tool = self.open_sessions.get(session).and_then(|open| open.tools.get(&model_name)).cloned();
                    let Some(tool) = tool else {
                        let _ = self.child_mut()?.interrupt(session, turn).await;
                        return Err(TurnFailure::new("tool_not_admitted", format!("Claude called '{model_name}', which is not in this session's admitted catalog")));
                    };
                    return Ok(TurnOutcome::ToolCall { call_id, tool, arguments: Value::Object(input), claude_session_id });
                }
                Event::Usage { session: name, turn: t, usage: observed, .. } if name == session && t == turn => usage = Some(observed),
                Event::Error { fatal: true, code, message, .. } => {
                    self.child = None;
                    self.open_sessions.clear();
                    self.pending_calls.clear();
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
                            let text = result.filter(|result| !result.trim().is_empty()).unwrap_or_else(|| text.join("\n\n"));
                            if text.trim().is_empty() {
                                Err(TurnFailure::new("empty_reply", "Claude Code completed the turn without text"))
                            } else {
                                Ok(TurnOutcome::Reply(TurnReply { text, claude_session_id, usage }))
                            }
                        }
                        TurnStatus::Interrupted => Err(TurnFailure::new("turn_interrupted", "the Claude turn was interrupted")),
                        TurnStatus::Failed => {
                            self.open_sessions.remove(session);
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
            self.pending_calls.clear();
        }
        TurnFailure::new(&error.code, error.message)
    }

    fn child_lost(&mut self, message: &str) -> TurnFailure {
        self.child = None;
        self.open_sessions.clear();
        self.pending_calls.clear();
        TurnFailure::new("child_exited", message)
    }

    async fn hand_reply(&self, handoff: &ProviderOutputHandoff, reply_to: Option<&Value>, live: LiveTurn, turn: &str, reply: TurnReply) -> Result<(), String> {
        let item_id = live.reply_item_id(&reply.text).unwrap_or_else(|| format!("msg_{turn}"));
        let mut value = json!({
            "thread_id": reply.claude_session_id,
            "turn_id": turn,
            "item_id": item_id,
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
        self.hand_terminal(handoff, REPLY_LABEL, reply_to, Some(live), value).await
    }

    async fn hand_tool_call(&self, handoff: &ProviderOutputHandoff, tool: &str, arguments: &Value, call_id: &str, live: &mut LiveTurn) -> Result<bool, String> {
        let value = json!({"tool": tool, "arguments": arguments, "correlation_id": call_id});
        let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
        let artifact = InterfaceArtifactFile::write(self.ctx.var_dir.join("emitted"), TOOL_CALL_LABEL, &bytes).map_err(|error| error.to_string())?;
        live.boundary(TOOL_CALL_LABEL, &artifact)?;
        let outcome = handoff
            .hand_final(ProviderEmission { artifact, route: ProviderEmissionRoute::Tool { tool: tool.to_string() } })
            .await?;
        Ok(matches!(outcome, octopus_run_authoring::ProviderHandoffOutcome::Admitted { .. }))
    }

    async fn hand_failure(&self, handoff: &ProviderOutputHandoff, reply_to: Option<&Value>, live: Option<LiveTurn>, failure: &TurnFailure) -> Result<(), String> {
        let mut value = json!({
            "message": failure.message,
            "will_retry": false,
            "additional_details": {"code": failure.code},
        });
        if failure.code == "claude_authentication_failed" {
            value["failure_code"] = Value::String(AUTHENTICATION_FAILURE_CODE.into());
        }
        self.hand_terminal(handoff, TURN_ERROR_LABEL, reply_to, live, value).await
    }

    /// Hands a client-visible terminal output. The payload names its own
    /// label, as every Codex output does, so a later run that is handed this
    /// output as context can read it without the manifest. `reply_to` is the admitted
    /// turn input this output answers. It is recorded as `in_reply_to`, the
    /// same link the Codex provider writes, so the client can attribute the
    /// output to its source; for a voice delegation that is what lets the
    /// call speak this answer under the delegation's ids. A turn that
    /// streamed hands its sealed `turn.stream` first, as Codex hands its
    /// terminal group.
    async fn hand_terminal(
        &self,
        handoff: &ProviderOutputHandoff,
        label: &str,
        reply_to: Option<&Value>,
        live: Option<LiveTurn>,
        mut value: Value,
    ) -> Result<(), String> {
        value["label"] = Value::String(label.to_string());
        if let Some(source) = reply_to {
            value["in_reply_to"] = source.clone();
        }
        let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
        let artifact = InterfaceArtifactFile::write(self.ctx.var_dir.join("emitted"), label, &bytes).map_err(|error| error.to_string())?;
        if let Some(stream) = live.map(|live| live.seal(label, &artifact)).transpose()?.flatten() {
            let outcomes = handoff
                .hand_progress_batch(vec![ProviderEmission { artifact: stream, route: ProviderEmissionRoute::ClientProjection }])
                .await?;
            if !outcomes.iter().all(|outcome| matches!(outcome, octopus_run_authoring::ProviderHandoffOutcome::Admitted { .. })) {
                return Ok(());
            }
        }
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
