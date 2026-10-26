use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{stream::FuturesUnordered, StreamExt};
use octopus_interface_transport::{InterfaceLifeFuture, InterfaceLiftContext, InterfaceLiftFn};
use octopus_interfaces::{InterfaceDescriptor, InterfaceInvocationEnvelope};
use octopus_run_authoring::{
    ProviderHandoffSession, ProviderOutputHandoff, RunAuthoringResultIdentity,
};
use octopus_world_pyecho_life_runtime::{LedgerReplayReader, LedgerTailReader};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::handoff::{EmissionHandoff, advance_source, flush, queue, queue_refusal};
use crate::protocol::{accept_event, call_transcript, seal_transcripts, update_frames};
use crate::state::{Call, Operation, Store};
use crate::wire::{CallCreationFailure, LiveClient, SidebandCommand, SidebandEvent};
use crate::{
    formed_provider_model, load_door_config, merge_session, validate_identity, RealtimeDoorConfig,
    SessionOffer, SessionRecording, SessionStop, SessionUpdate, CALL_TRANSCRIPT_LABEL, SESSION_ANSWER_LABEL,
    SESSION_OFFER_LABEL, SESSION_RECORDING_LABEL, SESSION_STOP_LABEL, SESSION_UPDATE_LABEL,
};

type Control = mpsc::Sender<SidebandCommand>;

pub fn interface_life() -> InterfaceLiftFn {
    Arc::new(|ctx| Box::pin(door_life(ctx)) as InterfaceLifeFuture)
}

async fn handoff_for(
    ctx: &InterfaceLiftContext,
    descriptor: &InterfaceDescriptor,
    session: &ProviderHandoffSession,
    envelope: &InterfaceInvocationEnvelope,
    seq: u64,
) -> Result<ProviderOutputHandoff, String> {
    let runtime = envelope.runtime().map_err(|error| error.to_string())?;
    let pinned = ctx.pinned_run_record_bytes(envelope)?;
    session
        .from_invocation_when_ready(ctx, descriptor, &runtime.run, envelope, seq, &pinned)
        .await.map_err(Into::into)
}

pub(crate) async fn recover_handoffs(
    ctx: &InterfaceLiftContext,
    descriptor: &InterfaceDescriptor,
    session: &ProviderHandoffSession,
    mut needed: BTreeSet<u64>,
) -> Result<BTreeMap<u64, ProviderOutputHandoff>, String> {
    let mut handoffs = BTreeMap::new();
    if needed.is_empty() {
        return Ok(handoffs);
    }
    let mut origins = LedgerReplayReader::open(ctx)?;
    while let Some(batch) = origins.read_batch(1)? {
        if ctx.cancel.is_cancelled() {
            return Err("voice source recovery cancelled".into());
        }
        for own in batch {
            let seq = own.movement.seq.0;
            if !needed.contains(&seq) {
                continue;
            }
            let envelope = origins.envelope(&own)?;
            let handoff = handoff_for(ctx, descriptor, session, &envelope, seq).await?;
            handoffs.insert(seq, handoff);
            needed.remove(&seq);
        }
        if needed.is_empty() {
            return Ok(handoffs);
        }
        tokio::task::yield_now().await;
    }
    Err(format!(
        "voice private state references missing checked source movements: {needed:?}"
    ))
}

pub(crate) async fn door_life(ctx: InterfaceLiftContext) -> Result<(), String> {
    let config = load_door_config(&ctx)?;
    let descriptor = ctx.resolved_interface_descriptor()?;
    let authoring_results = RunAuthoringResultIdentity::from_descriptor(&descriptor)?;
    let session = ProviderHandoffSession::new(&ctx)?;
    let mut reader = LedgerTailReader::open(&ctx)?;
    let mut store = Store::open(
        &ctx.var_dir,
        ctx.required_host_io_limits()?.max_payload_bytes,
    )?;
    let mut handoffs = BTreeMap::new();
    let mut controls: BTreeMap<String, Control> = BTreeMap::new();
    let (events_tx, mut events_rx) = mpsc::channel::<SidebandEvent>(128);

    let needed_calls: BTreeSet<_> = store
        .state
        .calls
        .values()
        .filter(|call| {
            matches!(
                call.status.as_str(),
                "creating" | "created" | "attached" | "reconnecting"
            ) || call
                .updates
                .values()
                .chain(call.stops.values())
                .any(|op| op.result.is_none())
                || store.state.pending.iter().any(|entry| {
                    entry.correlation_id.as_deref() == Some(call.correlation_id.as_str())
                })
        })
        .map(|call| call.correlation_id.clone())
        .collect();
    if !needed_calls.is_empty()
        || !store.state.sources.is_empty()
        || !store.state.pending.is_empty()
    {
        let needed: BTreeSet<_> = needed_calls
            .iter()
            .map(|id| store.state.calls[id].source_seq)
            .chain(store.state.pending.iter().map(|entry| entry.source_seq))
            .chain(store.state.sources.values().copied())
            .collect();
        handoffs = recover_handoffs(&ctx, &descriptor, &session, needed).await?;
        flush(&ctx.var_dir, &ctx.interface, &mut store, &handoffs).await?;
        for correlation in needed_calls {
            recover_uncertain_operations(&mut store, &correlation)?;
            let call = store
                .state
                .calls
                .get_mut(&correlation)
                .ok_or("call disappeared")?;
            if call.remote_closed() {
                call.status = "closed".into();
            } else if call.status == "creating" {
                call.status = "failed".into();
                let body = call.event_body(json!({"ok":false,"creation_disposition":if call.call_id.is_some(){"created"}else{"unconfirmed"},"error":"call creation was interrupted; outcome unknown; offer not replayed"}));
                call.answer = Some(body.clone());
                queue(
                    &mut store,
                    &correlation,
                    SESSION_ANSWER_LABEL,
                    body,
                    false,
                    false,
                )?;
            } else if matches!(
                call.status.as_str(),
                "created" | "attached" | "reconnecting"
            ) {
                let awaiting_activation = call.status == "created";
                let pending_answer = awaiting_activation
                    .then(|| call.answer.clone())
                    .flatten();
                let call_id = call
                    .call_id
                    .clone()
                    .ok_or("active call has no provider identity")?;
                let client = LiveClient::connect(&config).await;
                let recovered = match client {
                    Ok(client) if call.auth_owner.as_deref() == Some(client.owner()) => {
                        if awaiting_activation { client.attach_created(&call_id, events_tx.clone()) }
                        else { client.attach(&call_id, events_tx.clone()).await }
                    }
                    _ => Err("call authentication changed or is unavailable".into()),
                };
                match recovered {
                    Ok(control) => {
                        call.status = if awaiting_activation { "created" } else { "attached" }.into();
                        controls.insert(call_id, control);
                        let recovered_answer = pending_answer.map(|mut answer| {
                            answer["sideband_connected"] = json!(!awaiting_activation);
                            call.answer = Some(answer.clone());
                            answer
                        });
                        let body = call.event_body(
                            json!({"state":call.status,"recovered":true,"media_connected":false}),
                        );
                        if let Some(answer) = recovered_answer {
                            queue(
                                &mut store,
                                &correlation,
                                SESSION_ANSWER_LABEL,
                                answer,
                                false,
                                false,
                            )?;
                        }
                        queue(
                            &mut store,
                            &correlation,
                            "realtime.session.state",
                            body,
                            false,
                            true,
                        )?;
                    }
                    Err(error) => {
                        call.status = "failed".into();
                        let body = call.event_body(
                            json!({"state":"failed","reason":error,"remote_closed":false}),
                        );
                        queue(
                            &mut store,
                            &correlation,
                            "realtime.session.state",
                            body,
                            false,
                            true,
                        )?;
                    }
                }
            }
            store.save()?;
        }
        flush(&ctx.var_dir, &ctx.interface, &mut store, &handoffs).await?;
    }
    ctx.signal_ready().await?;

    loop {
        if ctx.cancel.is_cancelled() {
            close_controls(&config, &mut store, controls, &mut events_rx).await?;
            return Ok(());
        }
        let batch = reader.read_new()?;
        for own in batch {
            if ctx.cancel.is_cancelled() {
                break;
            }
            let envelope = match reader.envelope(&own) {
                Ok(envelope) => envelope,
                Err(error) => {
                    ctx.hand_admitted_failure(
                        own.movement.seq.0,
                        "poisoned_voice_outbound",
                        json!({"error":error}),
                    )
                    .await?;
                    reader.commit_through(&own)?;
                    continue;
                }
            };
            let manifest = envelope
                .read_artifact_manifest()
                .map_err(|error| error.to_string())?;
            if authoring_results
                .consume_if_matches(&ctx, &own.movement, &envelope, &manifest.label)
                .await?
            {
                reader.commit_through(&own)?;
                continue;
            }
            let runtime = envelope.runtime().map_err(|error| error.to_string())?;
            advance_source(&mut store, runtime.run.as_str(), own.movement.seq.0)?;
            flush(&ctx.var_dir, &ctx.interface, &mut store, &handoffs).await?;
            let handoff =
                handoff_for(&ctx, &descriptor, &session, &envelope, own.movement.seq.0).await?;
            handoffs.insert(own.movement.seq.0, handoff.clone());
            let payload = envelope
                .read_artifact_payload()
                .map_err(|error| error.to_string())?;
            let response_label = match manifest.label.as_str() {
                SESSION_UPDATE_LABEL => "realtime.session.updated",
                SESSION_STOP_LABEL => "realtime.session.closed",
                SESSION_RECORDING_LABEL => "realtime.session.recorded",
                _ => SESSION_ANSWER_LABEL,
            };
            let raw: Value = match serde_json::from_slice(&payload) {
                Ok(raw) => raw,
                Err(_) => {
                    queue_refusal(
                        &mut store,
                        own.movement.seq.0,
                        response_label,
                        None,
                        "voice control payload is not JSON",
                    )?;
                    store.save()?;
                    flush(&ctx.var_dir, &ctx.interface, &mut store, &handoffs).await?;
                    reader.commit_through(&own)?;
                    continue;
                }
            };
            let model_grant = if matches!(
                manifest.label.as_str(),
                SESSION_OFFER_LABEL | SESSION_UPDATE_LABEL
            ) {
                formed_provider_model(&config, &envelope)
            } else {
                Ok(())
            };
            if let Err(error) = model_grant {
                queue_refusal(
                    &mut store,
                    own.movement.seq.0,
                    response_label,
                    Some(&raw),
                    &format!("provider_model_unavailable: {error}"),
                )?;
                store.save()?;
                flush(&ctx.var_dir, &ctx.interface, &mut store, &handoffs).await?;
                reader.commit_through(&own)?;
                continue;
            }
            let result = match manifest.label.as_str() {
                SESSION_OFFER_LABEL => match serde_json::from_value::<SessionOffer>(raw.clone()) {
                    Ok(offer) => {
                        if !envelope
                            .allowed_interfaces()
                            .map_err(|error| error.to_string())?
                            .contains(&offer.delegation_interface)
                        {
                            Err("voice delegation interface is outside the formed grant".into())
                        } else {
                            let hands_transcript = crate::handoff::authors_interface_output(
                                &handoff.record().await,
                                &ctx.interface,
                                CALL_TRANSCRIPT_LABEL,
                                &offer.delegation_interface,
                            );
                            let result = offer_call(
                                &config,
                                &mut store,
                                &mut controls,
                                &events_tx,
                                offer.clone(),
                                blake3::hash(&payload).to_hex().to_string(),
                                own.movement.seq.0,
                            )
                            .await;
                            if let Some(call) = store.state.calls.get_mut(&offer.correlation_id) {
                                if result.is_ok() {
                                    call.source_seq = own.movement.seq.0;
                                    call.hands_transcript |= hands_transcript;
                                }
                                handoffs.insert(own.movement.seq.0, handoff.clone());
                            }
                            result
                        }
                    }
                    Err(_) => Err("invalid realtime.session.offer payload".into()),
                },
                SESSION_UPDATE_LABEL => {
                    match serde_json::from_value::<SessionUpdate>(raw.clone()) {
                        Ok(update) => {
                            if let Some(call) = store.state.calls.get_mut(&update.correlation_id) {
                                handoffs.insert(own.movement.seq.0, handoff.clone());
                                call.source_seq = own.movement.seq.0;
                            }
                            update_call(
                                &config,
                                &mut store,
                                &controls,
                                &mut events_rx,
                                update,
                                blake3::hash(&payload).to_hex().to_string(),
                            )
                            .await
                        }
                        Err(_) => Err("invalid realtime.session.update payload".into()),
                    }
                }
                SESSION_STOP_LABEL => match serde_json::from_value::<SessionStop>(raw.clone()) {
                    Ok(stop) => {
                        if let Some(call) = store.state.calls.get_mut(&stop.correlation_id) {
                            handoffs.insert(own.movement.seq.0, handoff.clone());
                            call.source_seq = own.movement.seq.0;
                        }
                        stop_call(
                            &config,
                            &mut store,
                            &mut controls,
                            &events_tx,
                            &mut events_rx,
                            stop,
                            blake3::hash(&payload).to_hex().to_string(),
                        )
                        .await
                    }
                    Err(_) => Err("invalid realtime.session.stop payload".into()),
                },
                SESSION_RECORDING_LABEL => {
                    match serde_json::from_value::<SessionRecording>(raw.clone()) {
                        Ok(recording) => {
                            let result = recording_receipt(&store, &recording);
                            match result {
                                Ok(body) => {
                                    let call = store
                                        .state
                                        .calls
                                        .get_mut(&recording.correlation_id)
                                        .ok_or("recording owner disappeared")?;
                                    call.source_seq = own.movement.seq.0;
                                    handoffs.insert(own.movement.seq.0, handoff.clone());
                                    queue(
                                        &mut store,
                                        &recording.correlation_id,
                                        "realtime.session.recorded",
                                        body,
                                        false,
                                        false,
                                    )?;
                                    Ok(())
                                }
                                Err(error) => Err(error),
                            }
                        }
                        Err(_) => Err("invalid realtime.session.recording payload".into()),
                    }
                }
                _ => Err("unsupported realtime artifact label".into()),
            };
            if let Err(error) = result {
                queue_refusal(
                    &mut store,
                    own.movement.seq.0,
                    response_label,
                    Some(&raw),
                    &error,
                )?;
            }
            store.save()?;
            flush(&ctx.var_dir, &ctx.interface, &mut store, &handoffs).await?;
            reader.commit_through(&own)?;
        }
        tokio::select! {
            _ = ctx.cancel.cancelled() => {},
            result = reader.wait_for_change(&ctx.cancel) => result?,
            Some(event) = events_rx.recv() => {
                let available = events_rx.len();
                apply_sideband_events(&config, &mut store, std::iter::once(event).chain(
                    (0..available).map_while(|_| events_rx.try_recv().ok()),
                ))?;
                controls.retain(|call_id, _| !store.state.calls.values().any(|call|
                    call.call_id.as_deref() == Some(call_id.as_str()) && call.status == "closed"
                ));
                flush(&ctx.var_dir, &ctx.interface,&mut store,&handoffs).await?;
            }
        }
    }
}

fn apply_sideband_event(
    config: &RealtimeDoorConfig,
    store: &mut Store,
    event: SidebandEvent,
) -> Result<(), String> {
    apply_sideband_events(config, store, std::iter::once(event))
}

fn apply_sideband_events(
    config: &RealtimeDoorConfig,
    store: &mut Store,
    events: impl IntoIterator<Item = SidebandEvent>,
) -> Result<(), String> {
    let result = (|| {
        for event in events {
            let correlation = correlation_for_call(store, &event.call_id)?;
            let call = store
                .state
                .calls
                .get_mut(&correlation)
                .ok_or("call disappeared")?;
            match accept_event(
                config.private.protocol,
                call,
                &event.event,
                config.private.max_transcript_bytes,
            ) {
                Ok(outputs) => {
                    for (label, body, delegated) in outputs {
                        queue(store, &correlation, &label, body, delegated, true)?;
                    }
                }
                Err(error) => {
                    call.status = "failed".into();
                    let body = call
                        .event_body(json!({"state":"failed","reason":error,"remote_closed":false}));
                    queue(
                        store,
                        &correlation,
                        "realtime.session.state",
                        body,
                        false,
                        true,
                    )?;
                }
            }
        }
        Ok(())
    })();
    store.save()?;
    result
}

fn correlation_for_call(store: &Store, call_id: &str) -> Result<String, String> {
    let mut matches = store
        .state
        .calls
        .iter()
        .filter(|(_, call)| call.call_id.as_deref() == Some(call_id));
    let (correlation, call) = matches
        .next()
        .ok_or("sideband event has no exact call owner")?;
    if matches.next().is_some() || correlation != &call.correlation_id {
        return Err("provider call identity has no unique exact correlation owner".into());
    }
    Ok(correlation.clone())
}

fn drain_available_events(
    config: &RealtimeDoorConfig,
    store: &mut Store,
    events: &mut mpsc::Receiver<SidebandEvent>,
) -> Result<(), String> {
    let available = events.len();
    if available == 0 {
        return Ok(());
    }
    apply_sideband_events(
        config,
        store,
        (0..available).map_while(|_| events.try_recv().ok()),
    )
}

async fn close_controls(
    config: &RealtimeDoorConfig,
    store: &mut Store,
    controls: BTreeMap<String, Control>,
    events: &mut mpsc::Receiver<SidebandEvent>,
) -> Result<(), String> {
    let mut closing = FuturesUnordered::new();
    for (call_id, control) in controls {
        closing.push(async move {
            let outcome = send_command(&control, Vec::new(), true, Duration::from_secs(5)).await;
            (call_id, outcome)
        });
    }
    drain_available_events(config, store, events)?;
    loop {
        tokio::select! {
            biased;
            completion = closing.next() => {
                let Some((call_id, outcome)) = completion else { break; };
                drain_available_events(config, store, events)?;
                let correlation = correlation_for_call(store, &call_id)?;
                let confirmed = remote_closure_confirmed(store, &correlation, &outcome);
                let call = store.state.calls.get_mut(&correlation).ok_or("call disappeared")?;
                call.status = if confirmed { "closed" } else { "failed" }.into();
                let mut sealed = seal_transcripts(call, "interface_stopped");
                sealed.extend(call_transcript(call, "interface_stopped"));
                let body = call.event_body(json!({"provider_close_sent":outcome.is_ok(),"remote_closed":confirmed,"reason":"interface_stopped","error":outcome.err(),"transcript":call.transcript}));
                for (label, body, delegated) in sealed {
                    queue(store, &correlation, &label, body, delegated, true)?;
                }
                queue(store, &correlation, "realtime.session.closed", body, false, true)?;
                store.save()?;
            }
            Some(event) = events.recv() => { apply_sideband_event(config, store, event)?; }
        }
    }
    store.save()
}

fn recover_uncertain_operations(store: &mut Store, correlation: &str) -> Result<(), String> {
    let call = store
        .state
        .calls
        .get_mut(correlation)
        .ok_or("recovery owner disappeared")?;
    let updates: Vec<_> = call
        .updates
        .iter()
        .filter(|(_, op)| op.result.is_none())
        .map(|(id, _)| id.clone())
        .collect();
    let stops: Vec<_> = call
        .stops
        .iter()
        .filter(|(_, op)| op.result.is_none())
        .map(|(id, _)| id.clone())
        .collect();
    let mut emissions = Vec::new();
    for id in updates {
        let body = call.event_body(json!({"ok":false,"update_id":id,"status":"uncertain","heard_audio":false,"error":"interface restarted during update; injection unknown; not replayed"}));
        call.updates
            .get_mut(&id)
            .ok_or("update disappeared")?
            .result = Some(body.clone());
        emissions.push(("realtime.session.updated", body));
    }
    let sealed = if stops.is_empty() {
        Vec::new()
    } else {
        let mut sealed = seal_transcripts(call, "interrupted_stop");
        sealed.extend(call_transcript(call, "interrupted_stop"));
        sealed
    };
    let confirmed = call.remote_closed();
    for id in stops {
        call.status = if confirmed { "closed" } else { "failed" }.into();
        let body = call.event_body(json!({"ok":confirmed,"stop_id":id,"provider_close_sent":false,"remote_closed":confirmed,"transcript":call.transcript,"error":if confirmed {None}else{Some("interface restarted during stop; remote closure unknown; not reattached")}}));
        call.stops.get_mut(&id).ok_or("stop disappeared")?.result = Some(body.clone());
        emissions.push(("realtime.session.closed", body));
    }
    for (label, body, delegated) in sealed {
        queue(store, correlation, &label, body, delegated, true)?;
    }
    for (label, body) in emissions {
        queue(store, correlation, label, body, false, true)?;
    }
    store.save()
}

fn recording_receipt(store: &Store, recording: &SessionRecording) -> Result<Value, String> {
    if recording.schema != "octopus.voice_recording" || recording.schema_version != 1 {
        return Err("unsupported voice recording schema".into());
    }
    validate_identity(&recording.correlation_id, "recording correlation identity")?;
    if recording.started_at.is_empty()
        || recording.started_at.len() > 64
        || recording.started_at.chars().any(char::is_control)
    {
        return Err("invalid recording start time".into());
    }
    let media = &recording.media;
    if !std::path::Path::new(&media.path).is_absolute()
        || media.path.len() > 4096
        || media.path.chars().any(char::is_control)
        || !media.mime_type.starts_with("audio/")
        || media.mime_type.len() > 256
        || media.mime_type.chars().any(char::is_control)
        || media.size == 0
        || media.content_hash.len() != 64
        || !media
            .content_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("invalid voice recording media reference".into());
    }
    let call = store
        .state
        .calls
        .get(&recording.correlation_id)
        .ok_or("recording has no accepted offer identity")?;
    Ok(call.event_body(json!({"ok":true,"started_at":recording.started_at,"media":media,"evidence_only":true,"media_verified_by_provider":false,"heard_audio":false})))
}

async fn offer_call(
    config: &RealtimeDoorConfig,
    store: &mut Store,
    controls: &mut BTreeMap<String, Control>,
    events: &mpsc::Sender<SidebandEvent>,
    offer: SessionOffer,
    digest: String,
    source_seq: u64,
) -> Result<(), String> {
    validate_identity(&offer.correlation_id, "offer correlation identity")?;
    validate_identity(&offer.delegation_interface, "delegation interface")?;
    if !offer.offer_sdp.starts_with("v=0")
        || offer.offer_sdp.len() > 1_048_576
        || offer.offer_sdp.contains('\0')
    {
        return Err("offer_sdp is not bounded SDP".into());
    }
    let session = merge_session(
        &config.private.session,
        &offer.session,
        &config.private.model,
    )?;
    let mut session_configuration = session.clone();
    let configuration = session_configuration.as_object_mut().ok_or("voice session must be an object")?;
    configuration.remove("model");
    configuration.remove("initial_items");
    crate::client_context::validate(offer.client_context.as_deref())?;
    if let Some(call) = store.state.calls.get(&offer.correlation_id) {
        if call.offer_digest != digest {
            return Err("offer identity was reused with different content".into());
        }
        if matches!(call.status.as_str(), "closed" | "failed")
            && call
                .answer
                .as_ref()
                .is_some_and(|answer| answer.get("ok") == Some(&Value::Bool(true)))
        {
            return Err(
                "this offer's call is no longer active; a new call requires a new offer identity"
                    .into(),
            );
        }
        let body = call
            .answer
            .clone()
            .ok_or("call creation outcome unknown; refusing to replay offer")?;
        store
            .state
            .calls
            .get_mut(&offer.correlation_id)
            .ok_or("call disappeared")?
            .source_seq = source_seq;
        queue(
            store,
            &offer.correlation_id,
            SESSION_ANSWER_LABEL,
            body,
            false,
            false,
        )?;
        return Ok(());
    }
    let client = LiveClient::connect(config).await?;
    let correlation = offer.correlation_id.clone();
    store.state.calls.insert(
        correlation.clone(),
        Call {
            correlation_id: correlation.clone(),
            offer_digest: digest,
            call_id: None,
            source_seq,
            delegation_interface: offer.delegation_interface,
            status: "creating".into(),
            auth_owner: Some(client.owner().into()),
            answer: None,
            transcript: Vec::new(),
            provider_events: BTreeSet::new(),
            delegations: BTreeSet::new(),
            updates: BTreeMap::new(),
            stops: BTreeMap::new(),
            client_context: offer.client_context,
            session_configuration: Some(session_configuration),
            hands_transcript: false,
            transcript_handed: false,
        },
    );
    store.save()?;
    let opened = client.open_call(&offer.offer_sdp, &session).await;
    let result = match opened {
        Ok(opened) => {
            let call = store
                .state
                .calls
                .get_mut(&correlation)
                .ok_or("call disappeared")?;
            call.call_id = Some(opened.call_id.clone());
            call.status = "created".into();
            let response = json!({"ok":true,"creation_disposition":"created","correlation_id":correlation,"call_id":opened.call_id,"answer_sdp":opened.answer_sdp,"response_bytes":opened.response_bytes,"response_blake3":opened.response_blake3,"model":config.private.model,"protocol":config.private.protocol,"sideband_connected":false,"media_connected":false});
            call.answer = Some(response.clone());
            store.save()?;
            match client.attach_created(&opened.call_id, events.clone()) {
                Ok(control) => {
                    controls.insert(opened.call_id, control);
                    Ok(response)
                }
                Err(error) => Err(CallCreationFailure::created(error, opened.call_id)),
            }
        }
        Err(error) => {
            if let Some(id) = &error.call_id {
                store
                    .state
                    .calls
                    .get_mut(&correlation)
                    .ok_or("call disappeared")?
                    .call_id = Some(id.clone());
                store.save()?;
            }
            Err(error)
        }
    };
    let call = store
        .state
        .calls
        .get_mut(&correlation)
        .ok_or("call disappeared")?;
    let body = match result {
        Ok(body) => {
            call.status = "created".into();
            body
        }
        Err(error) => {
            call.status = "failed".into();
            call.event_body(
                json!({"ok":false,"creation_disposition":error.creation_disposition,"error":error.error,"sideband_connected":false,"remote_closed":false}),
            )
        }
    };
    call.answer = Some(body.clone());
    queue(
        store,
        &correlation,
        SESSION_ANSWER_LABEL,
        body,
        false,
        false,
    )?;
    store.save()
}

async fn update_call(
    config: &RealtimeDoorConfig,
    store: &mut Store,
    controls: &BTreeMap<String, Control>,
    events: &mut mpsc::Receiver<SidebandEvent>,
    update: SessionUpdate,
    digest: String,
) -> Result<(), String> {
    validate_identity(&update.update_id, "update identity")?;
    validate_identity(&update.correlation_id, "update correlation identity")?;
    validate_identity(&update.call_id, "update call identity")?;
    if update.text.len() > 65_536 {
        return Err("Live update exceeds bounded semantic payload".into());
    }
    crate::client_context::validate(update.client_context.as_deref())?;
    if correlation_for_call(store, &update.call_id)? != update.correlation_id {
        return Err("voice update call identity mismatch".into());
    }
    let call = store
        .state
        .calls
        .get_mut(&update.correlation_id)
        .ok_or("unknown voice offer identity")?;
    if call.call_id.as_deref() != Some(&update.call_id) {
        return Err("voice update call identity mismatch".into());
    }
    if let Some(id) = &update.delegation_id {
        if !call.delegations.contains(id) {
            return Err("unknown voice delegation identity".into());
        }
    }
    if let Some(operation) = call.updates.get(&update.update_id) {
        if operation.digest != digest {
            return Err("voice update identity was reused with different content".into());
        }
        let result = operation
            .result
            .clone()
            .ok_or("voice update outcome unknown; refusing to replay")?;
        queue(
            store,
            &update.correlation_id,
            "realtime.session.updated",
            result,
            false,
            false,
        )?;
        return Ok(());
    }
    if !matches!(call.status.as_str(), "attached" | "reconnecting") {
        return Err("voice call is not active for a new context update".into());
    }
    let credential = config.private.auth.resolve().await?;
    if call.auth_owner.as_deref() != Some(&credential.owner) {
        return Err("voice authentication changed; close this call and start explicitly".into());
    }
    if let Some(context) = update.client_context {
        if update.channel != crate::UpdateChannel::Context
            || update.delegation_id.is_some()
            || !update.text.is_empty()
        {
            return Err("client_context updates require channel=context, no delegation and no text".into());
        }
        let body = call.event_body(json!({"update_id":update.update_id,"delegation_id":null,"status":"context_retained","heard_audio":false,"ok":true}));
        call.client_context = Some(context);
        call.updates.insert(update.update_id, Operation { digest, result: Some(body.clone()) });
        queue(store, &update.correlation_id, "realtime.session.updated", body, false, false)?;
        return store.save();
    }
    let frames = update_frames(config.private.protocol, &update)?;
    let control = controls
        .get(&update.call_id)
        .ok_or("voice sideband is unavailable")?;
    call.updates.insert(
        update.update_id.clone(),
        Operation {
            digest,
            result: None,
        },
    );
    store.save()?;
    let sent = send_command_with_events(
        config,
        store,
        events,
        control,
        frames,
        false,
        Duration::from_millis(
            config
                .transport
                .request_timeout_ms
                .ok_or("request timeout absent")?,
        ),
    )
    .await;
    let call = store
        .state
        .calls
        .get_mut(&update.correlation_id)
        .ok_or("call disappeared")?;
    let body=call.event_body(json!({"update_id":update.update_id,"delegation_id":update.delegation_id,"status":if sent.is_ok(){"transport_written"}else{"uncertain"},"heard_audio":false,"ok":sent.is_ok(),"error":sent.err()}));
    call.updates
        .get_mut(&update.update_id)
        .ok_or("update disappeared")?
        .result = Some(body.clone());
    queue(
        store,
        &update.correlation_id,
        "realtime.session.updated",
        body,
        false,
        false,
    )?;
    store.save()
}

async fn stop_call(
    config: &RealtimeDoorConfig,
    store: &mut Store,
    controls: &mut BTreeMap<String, Control>,
    event_sender: &mpsc::Sender<SidebandEvent>,
    events: &mut mpsc::Receiver<SidebandEvent>,
    stop: SessionStop,
    digest: String,
) -> Result<(), String> {
    validate_identity(&stop.stop_id, "stop identity")?;
    validate_identity(&stop.correlation_id, "stop correlation identity")?;
    validate_identity(&stop.call_id, "stop call identity")?;
    drain_available_events(config, store, events)?;
    if correlation_for_call(store, &stop.call_id)? != stop.correlation_id {
        return Err("voice stop call identity mismatch".into());
    }
    let call = store
        .state
        .calls
        .get_mut(&stop.correlation_id)
        .ok_or("unknown voice offer identity")?;
    if call.call_id.as_deref() != Some(&stop.call_id) {
        return Err("voice stop call identity mismatch".into());
    }
    if let Some(operation) = call.stops.get(&stop.stop_id) {
        if operation.digest != digest {
            return Err("voice stop identity was reused with different content".into());
        }
        let mut body = operation
            .result
            .clone()
            .ok_or("voice stop outcome unknown; refusing to replay")?;
        if call.remote_closed() && body.get("remote_closed").and_then(Value::as_bool) != Some(true)
        {
            call.status = "closed".into();
            body["ok"] = json!(true);
            body["remote_closed"] = json!(true);
            body["error"] = Value::Null;
            body["transcript"] = json!(call.transcript);
            call.stops
                .get_mut(&stop.stop_id)
                .ok_or("stop disappeared")?
                .result = Some(body.clone());
        }
        queue(
            store,
            &stop.correlation_id,
            "realtime.session.closed",
            body,
            false,
            false,
        )?;
        return Ok(());
    }
    let already_closed = call.remote_closed();
    call.stops.insert(
        stop.stop_id.clone(),
        Operation {
            digest,
            result: None,
        },
    );
    store.save()?;
    let control = if already_closed {
        controls.remove(&stop.call_id);
        Ok(None)
    } else {
        match controls.remove(&stop.call_id) {
            Some(control) if !control.is_closed() => Ok((control, false)),
            _ => attach_stop_control(config, store, event_sender, &stop)
                .await
                .map(|control| (control, true)),
        }
        .map(Some)
    };
    let reattached = control
        .as_ref()
        .is_ok_and(|value| value.as_ref().is_some_and(|(_, reattached)| *reattached));
    let sent = match control {
        Ok(Some((control, _))) => {
            send_command_with_events(
                config,
                store,
                events,
                &control,
                Vec::new(),
                true,
                Duration::from_millis(
                    config
                        .transport
                        .request_timeout_ms
                        .ok_or("request timeout absent")?,
                )
                .saturating_add(Duration::from_secs(4)),
            )
            .await
        }
        Ok(None) => Ok(false),
        Err(error) => Err(error),
    };
    let confirmed = remote_closure_confirmed(store, &stop.correlation_id, &sent);
    let call = store
        .state
        .calls
        .get_mut(&stop.correlation_id)
        .ok_or("call disappeared")?;
    call.status = if confirmed { "closed" } else { "failed" }.into();
    let mut sealed = seal_transcripts(call, "local_stop");
    sealed.extend(call_transcript(call, "local_stop"));
    let body=call.event_body(json!({"stop_id":stop.stop_id,"ok":confirmed,"provider_close_sent":!already_closed && sent.is_ok(),"remote_closed":confirmed,"sideband_reattached":reattached,"error":sent.err(),"transcript":call.transcript}));
    call.stops
        .get_mut(&stop.stop_id)
        .ok_or("stop disappeared")?
        .result = Some(body.clone());
    for (label, body, delegated) in sealed {
        queue(store, &stop.correlation_id, &label, body, delegated, true)?;
    }
    queue(
        store,
        &stop.correlation_id,
        "realtime.session.closed",
        body,
        false,
        false,
    )?;
    store.save()
}

async fn attach_stop_control(
    config: &RealtimeDoorConfig,
    store: &Store,
    events: &mpsc::Sender<SidebandEvent>,
    stop: &SessionStop,
) -> Result<Control, String> {
    let call = store
        .state
        .calls
        .get(&stop.correlation_id)
        .ok_or("voice stop has no recorded call")?;
    if call.call_id.as_deref() != Some(&stop.call_id) {
        return Err("voice stop call identity mismatch".into());
    }
    let owner = call
        .auth_owner
        .as_deref()
        .ok_or("voice stop has no recorded authentication owner")?;
    let client = LiveClient::connect(config).await?;
    if owner != client.owner() {
        return Err("voice stop authentication differs from the call's recorded owner".into());
    }
    client.attach(&stop.call_id, events.clone()).await
}

fn remote_closure_confirmed(store: &Store, correlation: &str, sent: &Result<bool, String>) -> bool {
    let Some(call) = store.state.calls.get(correlation) else {
        return false;
    };
    let Some(call_id) = call.call_id.as_deref() else {
        return false;
    };
    if call.remote_closed() {
        return true;
    }
    if sent.as_ref().copied().unwrap_or(false) {
        return true;
    }
    store.state.pending.iter().any(|pending| {
        pending.correlation_id.as_deref() == Some(correlation)
            && pending.label == "realtime.session.closed"
            && pending.body.get("call_id").and_then(Value::as_str) == Some(call_id)
            && pending.body.get("remote_closed").and_then(Value::as_bool) == Some(true)
    })
}

async fn send_command(
    control: &Control,
    frames: Vec<Value>,
    close: bool,
    timeout: Duration,
) -> Result<bool, String> {
    let (completion, received) = oneshot::channel();
    tokio::time::timeout(timeout, async {
        control
            .send(SidebandCommand {
                frames,
                close,
                completion,
            })
            .await
            .map_err(|_| "voice sideband closed before command".to_string())?;
        received.await.map_err(|_| {
            "voice sideband command completion was lost; outcome unknown".to_string()
        })?
    })
    .await
    .map_err(|_| "voice sideband command timed out; outcome unknown".to_string())?
}

async fn send_command_with_events(
    config: &RealtimeDoorConfig,
    store: &mut Store,
    events: &mut mpsc::Receiver<SidebandEvent>,
    control: &Control,
    frames: Vec<Value>,
    close: bool,
    timeout: Duration,
) -> Result<bool, String> {
    let pending = send_command(control, frames, close, timeout);
    tokio::pin!(pending);
    let outcome = loop {
        tokio::select! {
            biased;
            result = &mut pending => break result,
            Some(event) = events.recv() => { apply_sideband_event(config, store, event)?; }
        }
    };
    drain_available_events(config, store, events)?;
    outcome
}

#[cfg(test)]
#[path = "../tests/support/realtime_lifecycle.rs"]
mod tests;
