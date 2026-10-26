use super::*;
use crate::state::{Call, Store};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex;

#[test]
fn control_refusals_retain_exact_operation_coordinates() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path(), 1_048_576).unwrap();
    let request = json!({"correlation_id":"offer","call_id":"rtc_call","update_id":"update","stop_id":"stop"});
    for (label, operation) in [("realtime.session.updated", "update_id"), ("realtime.session.closed", "stop_id")] {
        queue_refusal(&mut store, 7, label, Some(&request), "refused").unwrap();
        let body = &store.state.pending.last().unwrap().body;
        for field in ["correlation_id", "call_id", operation] { assert_eq!(body[field], request[field]); }
        assert_eq!(body["ok"], false);
    }
    let request = json!({"correlation_id":"call"});
    queue_refusal(&mut store, 7, "realtime.session.answer", Some(&request), "refused").unwrap();
    assert_eq!(store.state.pending.last().unwrap().body["creation_disposition"], "not_created");
    store = setup(root.path());
    queue_refusal(&mut store, 7, "realtime.session.answer", Some(&request), "refused").unwrap();
    assert_eq!(store.state.pending.last().unwrap().body["creation_disposition"], "created");
    assert_eq!(store.state.pending.last().unwrap().body["call_id"], "rtc_call");
    store.state.calls.get_mut("call").unwrap().call_id = None;
    queue_refusal(&mut store, 7, "realtime.session.answer", Some(&request), "refused").unwrap();
    assert_eq!(store.state.pending.last().unwrap().body["creation_disposition"], "unconfirmed");
}

#[derive(Clone, Copy)]
enum Seam {
    BeforeWrite,
    InstalledBeforeAck,
    AdmittedBeforeSave,
    StandingRoute,
    None,
}
struct Boundary {
    root: PathBuf,
    fail: Mutex<Seam>,
}
impl Boundary {
    fn read(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.root.join("run.json")).unwrap()).unwrap()
    }
    fn write(&self, record: &Value) {
        std::fs::write(
            self.root.join("run.json"),
            serde_json::to_vec(record).unwrap(),
        )
        .unwrap();
    }
    fn admission(&self) -> Vec<ProviderHandoffOutcome> {
        let record = self.read();
        let Some(item) = record["interface_state"]["voice"]["pending_handoff"]["items"]
            .as_array()
            .and_then(|items| items.first())
        else {
            return Vec::new();
        };
        let artifact = ArtifactRef {
            id: ArtifactId::new(item["artifact_id"].as_str().unwrap()),
            content: ContentHash::from_hex(item["artifact_content_hash"].as_str().unwrap())
                .unwrap(),
        };
        self.admit(artifact)
    }
    fn admit(&self, artifact: ArtifactRef) -> Vec<ProviderHandoffOutcome> {
        let ledger = self.root.join("admissions.json");
        let mut rows: Vec<ArtifactRef> = if ledger.exists() {
            serde_json::from_slice(&std::fs::read(&ledger).unwrap()).unwrap()
        } else {
            Vec::new()
        };
        if !rows.contains(&artifact) {
            rows.push(artifact.clone());
            std::fs::write(ledger, serde_json::to_vec(&rows).unwrap()).unwrap();
        }
        vec![ProviderHandoffOutcome::Admitted {
            seq: rows.iter().position(|row| row == &artifact).unwrap() as u64 + 1,
            artifact,
        }]
    }
    fn count(&self) -> usize {
        serde_json::from_slice::<Vec<Value>>(
            &std::fs::read(self.root.join("admissions.json")).unwrap(),
        )
        .unwrap()
        .len()
    }
}
impl EmissionHandoff for Boundary {
    async fn record(&self) -> Vec<u8> {
        serde_json::to_vec(&self.read()).unwrap()
    }
    async fn recover(&self) -> Result<Vec<ProviderHandoffOutcome>, String> {
        Ok(self.admission())
    }
    async fn emit(
        &self,
        emission: ProviderEmission,
        observation: bool,
        terminal: bool,
    ) -> Result<ProviderHandoffOutcome, String> {
        assert!(observation);
        let seam = std::mem::replace(&mut *self.fail.lock().unwrap(), Seam::None);
        if matches!(seam, Seam::BeforeWrite) {
            return Err("fixture crash before write".into());
        }
        let manifest = emission.artifact.read_manifest().unwrap();
        let identity = artifact_identity(&emission.artifact, &manifest.label).unwrap();
        let target = match emission.route {
            ProviderEmissionRoute::Interface { interface } => interface,
            _ => panic!("unexpected projection"),
        };
        assert_eq!(target.as_str(), "home");
        if matches!(seam, Seam::StandingRoute) {
            return Ok(self.admit(identity).remove(0));
        }
        let mut record = self.read();
        let generation = record["generation"].as_u64().unwrap() + 1;
        record["generation"] = json!(generation);
        record["interface_state"]["voice"]["pending_handoff"] = json!({
            "source_movement_seq":7,"terminal":terminal,"items":[{
                "artifact_id":identity.id,"artifact_content_hash":identity.content.to_hex(),"artifact_label":manifest.label,
                "checkpoint":{"interface_binding":binding("voice"),"outbound_interface_bindings":[binding("home")]}
            }]
        });
        self.write(&record);
        if matches!(seam, Seam::InstalledBeforeAck) {
            return Err("fixture lost file-write result/ACK".into());
        }
        let outcome = self.admission().remove(0);
        if matches!(seam, Seam::AdmittedBeforeSave) {
            return Err("fixture crash after admission before local save".into());
        }
        Ok(outcome)
    }
}
fn binding(interface: &str) -> AuthoredInterfaceBinding {
    AuthoredInterfaceBinding::all(InterfaceId::new(interface))
}
fn setup(root: &Path) -> Store {
    let record = json!({"generation":0,"interface_state":{"voice":{"run_authoring_binding":{"checkpoints":[{
        "role":"provider_interface_output","interface_binding":binding("voice"),"outbound_interface_bindings":[binding("home")],"required_verified_artifacts":[]
    }]}}}});
    std::fs::write(root.join("run.json"), serde_json::to_vec(&record).unwrap()).unwrap();
    let mut store = Store::open(root, 1_048_576).unwrap();
    store.state.calls.insert(
        "call".into(),
        Call {
            correlation_id: "call".into(),
            offer_digest: "offer".into(),
            call_id: Some("rtc_call".into()),
            source_seq: 7,
            delegation_interface: "home".into(),
            status: "attached".into(),
            auth_owner: None,
            answer: None,
            transcript: Vec::new(),
            provider_events: BTreeSet::new(),
            delegations: BTreeSet::new(),
            updates: BTreeMap::new(),
            stops: BTreeMap::new(),
            client_context: None,
            session_configuration: None,
            hands_transcript: false,
            transcript_handed: false,
        },
    );
    store
}
fn delegation(store: &mut Store) {
    queue(
        store,
        "call",
        "realtime.delegation",
        json!({"delegation_id":"d","input_text":"same words"}),
        true,
        true,
    )
    .unwrap();
    store.save().unwrap();
}

#[tokio::test]
async fn restart_reconciles_each_exact_pending_emission_at_both_crash_seams() {
    for seam in [Seam::InstalledBeforeAck, Seam::AdmittedBeforeSave] {
        let root = tempfile::tempdir().unwrap();
        let mut store = setup(root.path());
        delegation(&mut store);
        let boundary = Boundary {
            root: root.path().into(),
            fail: Mutex::new(seam),
        };
        let handoffs = BTreeMap::from([(7, boundary)]);
        assert!(flush(
            root.path(),
            &InterfaceId::new("voice"),
            &mut store,
            &handoffs
        )
        .await
        .is_err());
        let identity = store.state.pending[0]
            .delivery
            .as_ref()
            .unwrap()
            .artifact
            .clone();
        drop(store);
        let mut restored = Store::open(root.path(), 1_048_576).unwrap();
        assert_eq!(
            restored.state.pending[0]
                .delivery
                .as_ref()
                .unwrap()
                .artifact,
            identity
        );
        flush(
            root.path(),
            &InterfaceId::new("voice"),
            &mut restored,
            &handoffs,
        )
        .await
        .unwrap();
        assert!(restored.state.pending.is_empty());
        assert_eq!(handoffs[&7].read()["generation"], 1);
        assert_eq!(handoffs[&7].count(), 1);
        delegation(&mut restored);
        assert_ne!(restored.state.pending[0].body["emission_id"], json!(0));
        *handoffs[&7].fail.lock().unwrap() = Seam::BeforeWrite;
        assert!(flush(
            root.path(),
            &InterfaceId::new("voice"),
            &mut restored,
            &handoffs
        )
        .await
        .is_err());
        let mut restarted = Store::open(root.path(), 1_048_576).unwrap();
        flush(
            root.path(),
            &InterfaceId::new("voice"),
            &mut restarted,
            &handoffs,
        )
        .await
        .unwrap();
        assert_eq!(handoffs[&7].read()["generation"], 2);
        assert_eq!(handoffs[&7].count(), 2);
    }
}

#[tokio::test]
async fn admitted_identity_with_another_route_cannot_remove_or_reemit_pending_work() {
    let root = tempfile::tempdir().unwrap();
    let mut store = setup(root.path());
    delegation(&mut store);
    let boundary = Boundary {
        root: root.path().into(),
        fail: Mutex::new(Seam::AdmittedBeforeSave),
    };
    let handoffs = BTreeMap::from([(7, boundary)]);
    assert!(flush(
        root.path(),
        &InterfaceId::new("voice"),
        &mut store,
        &handoffs
    )
    .await
    .is_err());
    let mut record = handoffs[&7].read();
    record["interface_state"]["voice"]["pending_handoff"]["items"][0]["checkpoint"]
        ["outbound_interface_bindings"] = json!([binding("another_home")]);
    handoffs[&7].write(&record);
    let mut restored = Store::open(root.path(), 1_048_576).unwrap();
    assert!(flush(
        root.path(),
        &InterfaceId::new("voice"),
        &mut restored,
        &handoffs
    )
    .await
    .unwrap_err()
    .contains("source or route"));
    assert_eq!(restored.state.pending.len(), 1);
    assert_eq!(handoffs[&7].read()["generation"], 1);
    assert_eq!(handoffs[&7].count(), 1);
}

#[tokio::test]
async fn standing_route_admission_settles_pending_work_without_a_record_handoff() {
    let root = tempfile::tempdir().unwrap();
    let mut store = setup(root.path());
    delegation(&mut store);
    let handoffs = BTreeMap::from([(
        7,
        Boundary {
            root: root.path().into(),
            fail: Mutex::new(Seam::StandingRoute),
        },
    )]);
    flush(root.path(), &InterfaceId::new("voice"), &mut store, &handoffs)
        .await
        .unwrap();
    assert!(store.state.pending.is_empty());
    assert_eq!(handoffs[&7].read()["generation"], 0);
    assert_eq!(handoffs[&7].count(), 1);
}
