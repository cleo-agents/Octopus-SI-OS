use std::collections::BTreeMap;
use std::path::Path;

use octopus_descriptors::{ArtifactId, InterfaceId};
use octopus_interfaces::InterfaceArtifactFile;
use octopus_ledger::{ArtifactRef, ContentHash, RequiredVerifiedArtifact};
use octopus_policy::AuthoredInterfaceBinding;
use octopus_run_authoring::{
    ProviderEmission, ProviderEmissionRoute, ProviderHandoffOutcome, ProviderOutputHandoff,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::state::{DeliveryIdentity, PendingEmission, Store};

pub(crate) trait EmissionHandoff {
    async fn record(&self) -> Vec<u8>;
    async fn recover(&self) -> Result<Vec<ProviderHandoffOutcome>, String>;
    async fn emit(
        &self,
        emission: ProviderEmission,
        observation: bool,
        terminal: bool,
    ) -> Result<ProviderHandoffOutcome, String>;
}

impl EmissionHandoff for ProviderOutputHandoff {
    async fn record(&self) -> Vec<u8> {
        self.current_run_record_bytes().await
    }
    async fn recover(&self) -> Result<Vec<ProviderHandoffOutcome>, String> {
        self.recover_source_with_outcomes()
            .await
            .map(|(_, outcomes)| outcomes)
    }
    async fn emit(
        &self,
        emission: ProviderEmission,
        observation: bool,
        terminal: bool,
    ) -> Result<ProviderHandoffOutcome, String> {
        if observation {
            self.hand_observation(emission, terminal).await
        } else if terminal {
            self.hand_final(emission).await
        } else {
            self.hand(emission).await
        }
    }
}

pub(crate) fn queue(
    store: &mut Store,
    correlation: &str,
    label: &str,
    body: Value,
    delegated: bool,
    observation: bool,
) -> Result<(), String> {
    let call = store
        .state
        .calls
        .get(correlation)
        .ok_or("voice emission has no owning call")?;
    let source_seq = call.source_seq;
    let destination = delegated.then(|| call.delegation_interface.clone());
    enqueue(
        store,
        PendingEmission {
            correlation_id: Some(correlation.into()),
            label: label.into(),
            body,
            delegated,
            observation,
            terminal: false,
            source_seq,
            destination,
            delivery: None,
        },
    )
}

fn enqueue(store: &mut Store, mut pending: PendingEmission) -> Result<(), String> {
    let sequence = store.state.next_emission_seq;
    store.state.next_emission_seq = sequence
        .checked_add(1)
        .ok_or("voice emission sequence exhausted")?;
    pending.body["label"] = json!(pending.label);
    pending.body["emission_id"] = json!(sequence);
    if unpublished_transcript(&pending) {
        if let Some(previous) = store.state.pending.iter_mut().rev().find(|previous| {
            unpublished_transcript(previous)
                && same_call_source(previous, &pending)
                && previous.body.get("final").and_then(Value::as_bool) == Some(false)
                && previous.body["id"] == pending.body["id"]
                && previous.body["role"] == pending.body["role"]
        }) {
            *previous = pending;
            return Ok(());
        }
    }
    if pending.label == "realtime.session.closed"
        && pending.body.get("remote_closed").and_then(Value::as_bool) == Some(true)
        && !pending.delegated
        && !pending.terminal
        && pending.delivery.is_none()
    {
        let index = store
            .state
            .pending
            .iter()
            .rposition(|previous| {
                !unpublished_transcript(previous) || !same_call_source(previous, &pending)
            })
            .map_or(0, |index| index + 1);
        store.state.pending.insert(index, pending);
        return Ok(());
    }
    store.state.pending.push(pending);
    Ok(())
}

fn same_call_source(left: &PendingEmission, right: &PendingEmission) -> bool {
    left.source_seq == right.source_seq
        && left.correlation_id.is_some()
        && left.correlation_id == right.correlation_id
        && left.destination == right.destination
        && left.body.get("call_id").and_then(Value::as_str).is_some()
        && left.body["call_id"] == right.body["call_id"]
}

fn unpublished_transcript(pending: &PendingEmission) -> bool {
    pending.label == "realtime.transcript"
        && pending.observation
        && !pending.delegated
        && !pending.terminal
        && pending.delivery.is_none()
        && pending.body.get("id").and_then(Value::as_str).is_some()
        && pending.body.get("role").and_then(Value::as_str).is_some()
        && pending.body.get("text").and_then(Value::as_str).is_some()
        && pending.body.get("final").and_then(Value::as_bool).is_some()
}

pub(crate) fn queue_refusal(
    store: &mut Store,
    source_seq: u64,
    label: &str,
    request: Option<&Value>,
    error: &str,
) -> Result<(), String> {
    let identity = |key: &str| {
        request
            .and_then(|request| request.get(key))
            .and_then(Value::as_str)
            .filter(|value| crate::validate_identity(value, key).is_ok())
    };
    let correlation = identity("correlation_id");
    let mut body = json!({"ok":false,"correlation_id":correlation,"error":error});
    let operation = match label {
        "realtime.session.updated" => Some("update_id"),
        "realtime.session.closed" => Some("stop_id"),
        _ => None,
    };
    if let Some(operation) = operation {
        body["call_id"] = json!(identity("call_id"));
        body[operation] = json!(identity(operation));
        if label == "realtime.session.updated" {
            body["status"] = json!("refused");
            body["delegation_id"] = json!(identity("delegation_id"));
        } else {
            body["provider_close_sent"] = json!(false);
            body["remote_closed"] = json!(false);
        }
    }
    if label == "realtime.session.answer" {
        let call = correlation.and_then(|id| store.state.calls.get(id));
        body["creation_disposition"] = json!(match call {
            None => "not_created",
            Some(call) if call.call_id.is_some() => "created",
            Some(_) => "unconfirmed",
        });
        if let Some(identity) = call.and_then(|call| call.call_id.as_ref()) {
            body["call_id"] = json!(identity);
        }
    }
    enqueue(
        store,
        PendingEmission {
            correlation_id: correlation.map(str::to_owned),
            label: label.into(),
            body,
            delegated: false,
            observation: false,
            terminal: false,
            source_seq,
            destination: None,
            delivery: None,
        },
    )
}

pub(crate) fn advance_source(store: &mut Store, run: &str, source_seq: u64) -> Result<(), String> {
    if let Some(previous) = store.state.sources.get(run).copied() {
        if previous == source_seq {
            return Ok(());
        }
        if previous > source_seq {
            return Err("voice control source moved backwards".into());
        }
        if !store.state.pending.is_empty() {
            return Err("voice source cannot advance before pending evidence is reconciled".into());
        }
        enqueue(
            store,
            PendingEmission {
                correlation_id: None,
                label: "realtime.session.state".into(),
                body: json!({"state":"source_completed","source_movement_seq":previous,"next_source_movement_seq":source_seq}),
                delegated: false,
                observation: true,
                terminal: true,
                source_seq: previous,
                destination: None,
                delivery: None,
            },
        )?;
        for call in store
            .state
            .calls
            .values_mut()
            .filter(|call| call.source_seq == previous)
        {
            call.source_seq = source_seq;
        }
    }
    store.state.sources.insert(run.into(), source_seq);
    store.save()
}

#[derive(Deserialize)]
struct ProviderRecord {
    run_authoring_binding: Topology,
    pending_handoff: Option<ReplayBatch>,
}
#[derive(Deserialize)]
struct Topology {
    checkpoints: Vec<OutputTemplate>,
}
#[derive(Deserialize)]
struct OutputTemplate {
    role: String,
    interface_binding: AuthoredInterfaceBinding,
    outbound_interface_bindings: Vec<AuthoredInterfaceBinding>,
    required_verified_artifacts: Vec<RequiredVerifiedArtifact>,
}
#[derive(Deserialize)]
struct ReplayBatch {
    source_movement_seq: u64,
    terminal: bool,
    items: Vec<ReplayItem>,
}
#[derive(Deserialize)]
struct ReplayItem {
    artifact_id: ArtifactId,
    artifact_content_hash: String,
    artifact_label: String,
    checkpoint: ReplayCheckpoint,
}
#[derive(Deserialize)]
struct ReplayCheckpoint {
    interface_binding: AuthoredInterfaceBinding,
    outbound_interface_bindings: Vec<AuthoredInterfaceBinding>,
}

fn provider_record(bytes: &[u8], provider: &InterfaceId) -> Result<ProviderRecord, String> {
    let record: Value =
        serde_json::from_slice(bytes).map_err(|_| "checked voice run record is malformed")?;
    let value = record
        .get("interface_state")
        .and_then(|states| states.get(provider.as_str()))
        .ok_or("checked voice run record lost its exact provider state")?;
    serde_json::from_value(value.clone())
        .map_err(|_| "checked voice run record lost its handoff contract".into())
}

fn artifact_identity(artifact: &InterfaceArtifactFile, label: &str) -> Result<ArtifactRef, String> {
    let bytes = std::fs::read(artifact.manifest_path())
        .map_err(|_| "voice output manifest is unreadable")?;
    let content = ContentHash::of_bytes(&bytes);
    Ok(ArtifactRef {
        id: ArtifactId::new(format!("{label}:{}", content.to_hex())),
        content,
    })
}

fn expected_outbound(
    record: &ProviderRecord,
    provider: &InterfaceId,
    pending: &PendingEmission,
) -> Result<Vec<AuthoredInterfaceBinding>, String> {
    if pending.delegated != pending.destination.is_some() {
        return Err("voice emission route identity is inconsistent".into());
    }
    let role = if pending.delegated {
        "provider_interface_output"
    } else {
        "provider_artifact_output"
    };
    let candidates = record
        .run_authoring_binding
        .checkpoints
        .iter()
        .filter(|checkpoint| {
            checkpoint.role == role
                && checkpoint.interface_binding.interface == *provider
                && checkpoint.interface_binding.admits(&pending.label)
                && !checkpoint.outbound_interface_bindings.is_empty()
                && checkpoint
                    .outbound_interface_bindings
                    .iter()
                    .all(|binding| binding.admits(&pending.label))
                && match checkpoint.required_verified_artifacts.as_slice() {
                    [] => true,
                    [requirement] => requirement.artifact_label == pending.label,
                    _ => false,
                }
                && pending.destination.as_ref().is_none_or(|destination| {
                    checkpoint.outbound_interface_bindings.len() == 1
                        && checkpoint.outbound_interface_bindings[0].interface.as_str()
                            == destination
                })
        })
        .collect::<Vec<_>>();
    match candidates.as_slice() {
        [checkpoint] => Ok(checkpoint.outbound_interface_bindings.clone()),
        _ => Err("voice emission has no unique exact authored output route".into()),
    }
}

/// Whether the voice run authors a provider interface output route that
/// carries `label` to exactly `destination`.
pub(crate) fn authors_interface_output(record: &[u8], provider: &InterfaceId, label: &str, destination: &str) -> bool {
    let probe = PendingEmission {
        correlation_id: None,
        label: label.into(),
        body: Value::Null,
        delegated: true,
        observation: true,
        terminal: false,
        source_seq: 0,
        destination: Some(destination.into()),
        delivery: None,
    };
    provider_record(record, provider).is_ok_and(|record| expected_outbound(&record, provider, &probe).is_ok())
}

fn recovered_admission(
    record: &ProviderRecord,
    provider: &InterfaceId,
    pending: &PendingEmission,
    identity: &DeliveryIdentity,
    outcomes: &[ProviderHandoffOutcome],
) -> Result<bool, String> {
    let mut matches = 0;
    for outcome in outcomes {
        match outcome {
            ProviderHandoffOutcome::Admitted { artifact, .. } if artifact == &identity.artifact => {
                matches += 1
            }
            ProviderHandoffOutcome::Admitted { .. } => {}
            ProviderHandoffOutcome::TerminalFailure { .. } => {
                return Err("voice output recovery encountered a checked authoring failure".into());
            }
        }
    }
    if matches > 1 {
        return Err("voice output has repeated admitted recovery evidence".into());
    }
    let item = record.pending_handoff.as_ref().and_then(|batch| {
        batch
            .items
            .iter()
            .find(|item| item.artifact_id == identity.artifact.id)
    });
    match (matches, item) {
        (0, None) => Ok(false),
        (1, None) => Ok(true),
        (1, Some(item)) => {
            let batch = record
                .pending_handoff
                .as_ref()
                .ok_or("recovered handoff disappeared")?;
            if batch.source_movement_seq != pending.source_seq
                || batch.terminal != pending.terminal
                || item.artifact_content_hash != identity.artifact.content.to_hex()
                || item.artifact_label != pending.label
                || item.checkpoint.interface_binding.interface != *provider
                || !item.checkpoint.interface_binding.admits(&pending.label)
                || item.checkpoint.outbound_interface_bindings != identity.outbound
            {
                return Err(
                    "voice recovered artifact differs from its exact source or route".into(),
                );
            }
            Ok(true)
        }
        _ => Err("voice pending artifact and admitted recovery evidence disagree".into()),
    }
}

pub(crate) async fn flush<H: EmissionHandoff>(
    root: &Path,
    provider: &InterfaceId,
    store: &mut Store,
    handoffs: &BTreeMap<u64, H>,
) -> Result<(), String> {
    while let Some(mut pending) = store.state.pending.first().cloned() {
        let handoff = handoffs
            .get(&pending.source_seq)
            .ok_or("pending voice evidence has no checked source invocation")?;
        let artifact = crate::materialize_emitted_artifact(root, &pending.label, &pending.body)?;
        let expected_ref = artifact_identity(&artifact, &pending.label)?;
        if let Some(identity) = &pending.delivery {
            if identity.artifact != expected_ref {
                return Err("prepared voice output bytes changed before recovery".into());
            }
            let outcomes = handoff.recover().await?;
            let record = provider_record(&handoff.record().await, provider)?;
            if recovered_admission(&record, provider, &pending, identity, &outcomes)? {
                store.state.pending.remove(0);
                store.save()?;
                continue;
            }
            if identity.outbound != expected_outbound(&record, provider, &pending)? {
                return Err("prepared voice output route changed before admission".into());
            }
        } else {
            let record = provider_record(&handoff.record().await, provider)?;
            pending.delivery = Some(DeliveryIdentity {
                artifact: expected_ref,
                outbound: expected_outbound(&record, provider, &pending)?,
            });
            store.state.pending[0] = pending.clone();
            store.save()?;
        }
        let route = match &pending.destination {
            Some(interface) => ProviderEmissionRoute::Interface {
                interface: InterfaceId::new(interface),
            },
            None => ProviderEmissionRoute::ClientProjection,
        };
        let outcome = handoff
            .emit(
                ProviderEmission { artifact, route },
                pending.observation,
                pending.terminal,
            )
            .await?;
        let record = provider_record(&handoff.record().await, provider)?;
        if !recovered_admission(
            &record,
            provider,
            &pending,
            pending
                .delivery
                .as_ref()
                .ok_or("voice output preparation disappeared")?,
            &[outcome],
        )? {
            return Err("voice evidence failed exact checked artifact handoff".into());
        }
        store.state.pending.remove(0);
        store.save()?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "../tests/support/realtime_recovery.rs"]
mod tests;

#[cfg(test)]
#[path = "../tests/support/realtime_shared_recovery.rs"]
mod shared_recovery_tests;
