use serde_json::{json, Value};

use crate::state::{Call, TranscriptEntry};
use crate::{CALL_TRANSCRIPT_LABEL, LiveProtocol, SessionUpdate, UpdateChannel};

pub fn update_frames(protocol: LiveProtocol, update: &SessionUpdate) -> Result<Vec<Value>, String> {
    if update.client_context.is_some() {
        return Err("client_context belongs to delegation metadata, not the voice transport".into());
    }
    if update.text.trim().is_empty() {
        return Err("Live update text must be nonempty".into());
    }
    if protocol == LiveProtocol::CodexLive && update.channel == UpdateChannel::Instructions {
        return Err(
            "codex_live has no independent instructions append; use an explicit context update"
                .into(),
        );
    }
    let mut chunks = Vec::new();
    let mut text = update.text.as_str();
    while !text.is_empty() {
        let mut end = text.len().min(500);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(&text[..end]);
        text = &text[end..];
    }
    Ok(chunks.into_iter().enumerate().map(|(index,text)| {
        let event_id = format!("{}:{index}", update.update_id);
        match protocol {
            LiveProtocol::CodexLive => {
                let mut frame = json!({"type":if update.delegation_id.is_some(){"delegation.context.append"}else{"session.context.append"},"content":[{"type":"input_text","text":text}]});
                if let Some(id) = &update.delegation_id { frame["delegation_item_id"] = json!(id); }
                frame["channel"] = json!(if update.channel == UpdateChannel::Commentary { "speakable" } else { "commentary" });
                frame
            }
            LiveProtocol::OpenaiLive => json!({
                "type":match update.channel {UpdateChannel::Context=>"session.thinking.append",UpdateChannel::Commentary=>"session.commentary.append",UpdateChannel::Instructions=>"session.instructions.append"},
                "event_id":event_id,"delegation_id":update.delegation_id,"content":text
            }),
        }
    }).collect())
}

pub(crate) fn accept_event(
    protocol: LiveProtocol,
    call: &mut Call,
    event: &Value,
    max_bytes: usize,
) -> Result<Vec<(String, Value, bool)>, String> {
    if call.remote_closed() {
        call.status = "closed".into();
        return Ok(Vec::new());
    }
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .ok_or("provider event has no type")?;
    if !matches!(
        event_type,
        "octopus.transport.reconnecting"
            | "octopus.transport.connected"
            | "octopus.transport.failed"
            | "octopus.transport.stopped"
            | "session.closed"
            | "error"
            | "input_transcript.added"
            | "output_transcript.added"
            | "turn.done"
            | "session.input_transcript.delta"
            | "session.output_transcript.delta"
            | "delegation.created"
            | "session.delegation.created"
            | "session.thinking.appended"
            | "session.commentary.appended"
            | "session.instructions.appended"
            | "session.started"
            | "session.updated"
    ) {
        return Ok(Vec::new());
    }
    if call.transcript_bytes() > max_bytes {
        return Err("stored Live transcript exceeds declared limit".into());
    }
    let event_id = event
        .get("event_id")
        .map(|id| {
            id.as_str()
                .ok_or("provider event identity must be a string")
        })
        .transpose()?;
    if let Some(id) = event_id {
        crate::validate_identity(id, "provider event identity")?;
        if call.provider_events.contains(id) {
            return Ok(Vec::new());
        }
    }
    let mut output = Vec::new();
    match event_type {
        "octopus.transport.reconnecting"
        | "octopus.transport.connected"
        | "octopus.transport.failed" => {
            call.status = match event_type {
                "octopus.transport.reconnecting" => "reconnecting",
                "octopus.transport.connected" => "attached",
                _ => "failed",
            }
            .into();
            if call.status == "failed" {
                output.extend(seal_transcripts(call, "transport_failed"));
            }
            output.push(("realtime.session.state".into(), call.event_body(json!({"state":call.status,"reason":event.get("reason"),"attempt":event.get("attempt"),"provider_close_sent":event.get("provider_close_sent"),"remote_closed":event.get("remote_closed")})),false));
        }
        "session.closed" => {
            call.status = "closed".into();
            output.extend(seal_transcripts(call, "call_closed"));
            output.extend(call_transcript(call, "call_closed"));
            output.push(("realtime.session.closed".into(),call.event_body(json!({"provider_close_sent":false,"remote_closed":true,"transcript":call.transcript})),false));
        }
        "octopus.transport.stopped" => {
            call.status = if event.get("remote_closed").and_then(Value::as_bool) == Some(true) {
                "closed"
            } else {
                "failed"
            }
            .into();
            output.extend(seal_transcripts(call, "transport_stopped"));
            output.extend(call_transcript(call, "transport_stopped"));
            output.push(("realtime.session.closed".into(),call.event_body(json!({"provider_close_sent":event.get("provider_close_sent"),"remote_closed":event.get("remote_closed"),"transcript":call.transcript})),false));
        }
        "error" => {
            call.status = "failed".into();
            output.extend(seal_transcripts(call, "provider_error"));
            output.push(("realtime.session.state".into(),call.event_body(json!({"state":"failed","reason":"provider_error","provider_error":event.get("error"),"provider_event_id":event_id})),false));
        }
        "input_transcript.added" | "output_transcript.added"
            if protocol == LiveProtocol::CodexLive =>
        {
            let role = if event_type == "input_transcript.added" {
                "user"
            } else {
                "assistant"
            };
            let text = event
                .pointer("/item/text")
                .and_then(Value::as_str)
                .ok_or("Live transcript item has no text")?;
            let entry = append_transcript(call, role, text, false, max_bytes)?;
            output.push(("realtime.transcript".into(),call.event_body(json!({"id":entry.id,"role":role,"text":entry.text,"final":false,"provider_event_id":event_id})),false));
        }
        "turn.done" if protocol == LiveProtocol::CodexLive => {
            let role = event
                .pointer("/turn/role")
                .and_then(Value::as_str)
                .ok_or("Live turn has no role")?;
            if !matches!(role, "user" | "assistant") {
                return Err("Live turn has unsupported role".into());
            }
            let text = event
                .pointer("/turn/transcript")
                .and_then(Value::as_str)
                .ok_or("Live turn has no transcript")?;
            let entry = append_transcript(call, role, text, true, max_bytes)?;
            output.push(("realtime.transcript".into(),call.event_body(json!({"id":entry.id,"role":role,"text":text,"final":true,"boundary":"provider_turn","provider_event_id":event_id})),false));
        }
        "session.input_transcript.delta" | "session.output_transcript.delta"
            if protocol == LiveProtocol::OpenaiLive =>
        {
            let role = if event_type == "session.input_transcript.delta" {
                "user"
            } else {
                "assistant"
            };
            let text = event
                .get("delta")
                .and_then(Value::as_str)
                .ok_or("Live transcript delta has no text")?;
            let entry = append_transcript(call, role, text, false, max_bytes)?;
            output.push(("realtime.transcript".into(),call.event_body(json!({"id":entry.id,"role":role,"text":entry.text,"final":false,"delta":text,"start_ms":event.get("start_ms"),"end_ms":event.get("end_ms"),"provider_event_id":event_id})),false));
        }
        "delegation.created" if protocol == LiveProtocol::CodexLive => {
            let item = event.get("item").ok_or("Live delegation has no item")?;
            if item.get("type").and_then(Value::as_str) != Some("delegation")
                || item.get("target").and_then(Value::as_str) != Some("client")
            {
                return Err("Live provider attempted non-client delegation".into());
            }
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .ok_or("Live delegation has no identity")?;
            crate::validate_identity(id, "delegation identity")?;
            let mut text = String::new();
            for part in item
                .get("content")
                .and_then(Value::as_array)
                .ok_or("Live delegation has no content")?
            {
                if part.get("type").and_then(Value::as_str) != Some("input_text") {
                    return Err("Live delegation content must be input_text".into());
                }
                text.push_str(
                    part.get("text")
                        .and_then(Value::as_str)
                        .ok_or("Live delegation content has no text")?,
                );
            }
            if call.delegations.insert(id.into()) {
                if text.trim().is_empty() { return Err("Live delegation has no request text".into()); }
                output.push(("realtime.delegation".into(),call.delegation_body(json!({"delegation_id":id,"input_text":text,"transcript":call.transcript,"provider_event_id":event_id})),true));
            }
        }
        "session.delegation.created" if protocol == LiveProtocol::OpenaiLive => {
            let delegation = event.get("delegation").ok_or("Live delegation is absent")?;
            if delegation.get("target").and_then(Value::as_str) != Some("client") {
                return Err("Live provider attempted non-client delegation".into());
            }
            let id = delegation
                .get("id")
                .and_then(Value::as_str)
                .ok_or("Live delegation has no identity")?;
            crate::validate_identity(id, "delegation identity")?;
            if call.delegations.insert(id.into()) {
                output.extend(seal_transcripts(call, "delegation"));
                output.push(("realtime.delegation".into(),call.delegation_body(json!({"delegation_id":id,"input_text":null,"transcript":call.transcript,"offset_ms":event.get("offset_ms"),"provider_event_id":event_id})),true));
            }
        }
        "session.thinking.appended"
        | "session.commentary.appended"
        | "session.instructions.appended"
            if protocol == LiveProtocol::OpenaiLive =>
        {
            let id = event
                .get("client_event_id")
                .and_then(Value::as_str)
                .ok_or("Live update acknowledgment has no client_event_id")?;
            let (update_id, chunk) = id
                .rsplit_once(':')
                .ok_or("Live update acknowledgment has no chunk identity")?;
            let index = chunk
                .parse::<usize>()
                .map_err(|_| "Live update acknowledgment has invalid chunk identity")?;
            if index.to_string() != chunk {
                return Err("Live update acknowledgment has invalid chunk identity".into());
            }
            if !call.updates.contains_key(update_id) {
                return Err("Live update acknowledgment refers to an unknown update".into());
            }
            output.push(("realtime.session.updated".into(),call.event_body(json!({"update_id":update_id,"client_event_id":id,"status":"chunk_injected","heard_audio":false,"provider_event_id":event_id})),false));
        }
        "session.started" | "session.updated" => {
            call.status = "attached".into();
            output.push(("realtime.session.state".into(),call.event_body(json!({"state":"attached","provider_event":event_type,"provider_event_id":event_id})),false));
        }
        _ => {}
    }
    if let Some(id) = event_id {
        call.provider_events.insert(id.into());
    }
    Ok(output)
}

fn append_transcript(
    call: &mut Call,
    role: &str,
    text: &str,
    complete: bool,
    max_bytes: usize,
) -> Result<TranscriptEntry, String> {
    let replaced_bytes = if complete {
        call.transcript
            .iter()
            .rev()
            .find(|entry| entry.role == role && !entry.complete)
            .map_or(0, |entry| entry.text.len())
    } else {
        0
    };
    if call
        .transcript_bytes()
        .checked_sub(replaced_bytes)
        .and_then(|bytes| bytes.checked_add(text.len()))
        .is_none_or(|bytes| bytes > max_bytes)
    {
        return Err("Live transcript exceeds declared limit; explicit new call with selected context is required".into());
    }
    if let Some(entry) = call
        .transcript
        .iter_mut()
        .rev()
        .find(|entry| entry.role == role && !entry.complete)
    {
        if complete {
            entry.text = text.into();
            entry.complete = true;
        } else {
            entry.text.push_str(text);
        }
        Ok(entry.clone())
    } else {
        let entry = TranscriptEntry {
            id: format!(
                "{}:transcript:{}",
                call.correlation_id,
                call.transcript.len()
            ),
            role: role.into(),
            text: text.into(),
            complete,
        };
        call.transcript.push(entry.clone());
        Ok(entry)
    }
}

pub(crate) fn seal_transcripts(call: &mut Call, boundary: &str) -> Vec<(String, Value, bool)> {
    let entries: Vec<_> = call
        .transcript
        .iter_mut()
        .filter(|entry| !entry.complete)
        .map(|entry| {
            entry.complete = true;
            entry.clone()
        })
        .collect();
    entries.into_iter().map(|entry|("realtime.transcript".into(),call.event_body(json!({"id":entry.id,"role":entry.role,"text":entry.text,"final":true,"boundary":boundary,"provider_turn_complete":false})),false)).collect()
}

/// The call's final transcript, once per call, for the delegation interface
/// when the run authors that route.
pub(crate) fn call_transcript(call: &mut Call, boundary: &str) -> Option<(String, Value, bool)> {
    if !call.hands_transcript || call.transcript_handed || call.transcript.is_empty() {
        return None;
    }
    call.transcript_handed = true;
    Some((CALL_TRANSCRIPT_LABEL.into(), call.event_body(json!({"transcript":call.transcript,"boundary":boundary})), true))
}
