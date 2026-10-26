use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use octopus_descriptors::RunId;
use octopus_interface_transport::InterfaceLiftContext;
use octopus_ledger::ContentHash;
use octopus_world_pyecho_life_runtime::LedgerTailReader;
use serde_json::{Value, json};

pub(crate) struct PeerWait {
    pub result: Value,
    reader: LedgerTailReader,
}

impl PeerWait {
    pub(crate) fn commit(mut self) -> Result<(), String> { self.reader.commit() }
}

pub(crate) async fn wait(
    ctx: &InterfaceLiftContext,
    run: &RunId,
    call_id: &str,
    timeout_ms: u64,
    interrupted: &AtomicBool,
) -> Result<PeerWait, String> {
    if timeout_ms == 0 { return Err("peer wait requires a positive timeout".into()); }
    let name = format!("peer-wait-{}", ContentHash::of_bytes(run.as_str().as_bytes()).to_hex());
    let mut reader = LedgerTailReader::open_named(ctx, &name)?;
    let deadline = tokio::time::Instant::now().checked_add(Duration::from_millis(timeout_ms))
        .ok_or("peer wait deadline overflow")?;
    let mut notifications = Vec::new();
    loop {
        if ctx.cancel.is_cancelled() || interrupted.load(Ordering::Acquire) {
            return Ok(PeerWait { reader, result: json!({"ok":false,"interrupted":true,"notifications":[]}) });
        }
        let batch = reader.read_new_uncommitted_limit(64)?;
        let caught_up = batch.is_empty();
        for own in batch {
            if own.metadata()?.runtime.as_ref().is_none_or(|runtime| runtime.run != *run) { continue; }
            let input = reader.envelope(&own)?;
            let Some(message) = crate::handler::admitted_peer_message(&input, ctx.resolved_interface_descriptor()?.interface_driver_config.as_ref().map(|c| &c.private_config)).map_err(|error| error.to_string())? else { continue; };
            let label = input.read_artifact_manifest().map_err(|error| error.to_string())?.label;
            if message.action != crate::run_affordances::PeerAction::Queue { continue; }
            if label != crate::run_affordances::PEER_MESSAGE_LABEL && label != octopus_operator_chat_client::input_intake::INPUT_INTAKE_LABEL
                && !matches!(label.as_str(), "interface.artifact.output" | "interface.context.updated" | "turn.error" | "turn.control.acknowledged" | "turn.control.failed") { continue; }
            notifications.push(json!({
                "movement_seq": own.movement.seq.0, "artifact": input.artifact,
                "label": label, "message": message,
            }));
        }
        if !notifications.is_empty() || tokio::time::Instant::now() >= deadline {
            return Ok(PeerWait { reader, result: json!({
                "ok": true, "call_id": call_id, "notifications": notifications,
                "timed_out": notifications.is_empty(), "work_completed": false,
            }) });
        }
        if !caught_up { continue; }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        tokio::select! {
            result = reader.wait_for_change(&ctx.cancel) => result?,
            _ = tokio::time::sleep(remaining.min(Duration::from_millis(250))) => {},
        }
    }
}
