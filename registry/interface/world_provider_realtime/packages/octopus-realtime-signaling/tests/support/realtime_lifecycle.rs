use super::*;
use crate::protocol::{accept_event, update_frames};
use crate::wire::decode_call_id;
use crate::{LiveProtocol, RealtimeConfig, UpdateChannel};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

fn config(http: &str, ws: &str, protocol: LiveProtocol) -> RealtimeDoorConfig {
    let descriptor: Value =
        serde_json::from_str(include_str!("../../../../interface.json")).unwrap();
    let mut private: RealtimeConfig =
        serde_json::from_value(descriptor["interface_driver_config"]["private_config"].clone())
            .unwrap();
    private.protocol = protocol;
    private.auth = crate::auth::AuthConfig::BearerEnv {
        env_key: "OCTOPUS_REALTIME_CONTRACT_TEST_BEARER".into(),
    };
    private.sideband_url = ws.into();
    let mut transport: octopus_interfaces::InterfaceTransportConfig =
        serde_json::from_value(descriptor["interface_driver_config"]["transport"].clone()).unwrap();
    transport.base_url = http.into();
    if protocol == LiveProtocol::OpenaiLive {
        transport.headers.clear();
    }
    RealtimeDoorConfig { transport, private }
}

fn call() -> Call {
    Call {
        correlation_id: "offer".into(),
        offer_digest: "hash".into(),
        call_id: Some("rtc_fixture".into()),
        source_seq: 1,
        delegation_interface: "home_provider".into(),
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
    }
}

#[tokio::test]
async fn client_observation_is_retained_without_voice_messages_and_replayed_exactly() {
    let context = |state: &str| -> Vec<crate::ClientContextEntry> { serde_json::from_value(json!([
        {"name":"client_observation","text":json!({"widgets":[{"widget_id":"arbitrary.widget.Ω","source_digest":"sha256:0123456789abcdef","state":state}]}).to_string()}
    ])).unwrap() };
    let key = "OCTOPUS_CLIENT_OBSERVATION_TEST_BEARER";
    unsafe { std::env::set_var(key, "fixture-context-secret"); }
    let mut config = config("http://127.0.0.1:1/live", "ws://127.0.0.1:1/live", LiveProtocol::CodexLive);
    config.private.auth = crate::auth::AuthConfig::BearerEnv { env_key: key.into() };
    let root = tempfile::tempdir().unwrap(); let mut store = Store::open(root.path(), 1_048_576).unwrap();
    let legacy = serde_json::to_value(call()).unwrap(); assert!(legacy.get("client_context").is_none());
    let mut owner: Call = serde_json::from_value(legacy).unwrap(); assert!(owner.client_context.is_none());
    owner.auth_owner = Some(config.private.auth.resolve().await.unwrap().owner);
    owner.client_context = Some(context("hidden")); store.state.calls.insert("offer".into(), owner);
    let instructions = "Custom instructions from this accepted offer";
    store.state.calls.get_mut("offer").unwrap().session_configuration = Some(json!({"instructions":instructions,
        "audio":{"output":{"voice":"marin"}},"delegation":{"type":"client"}}));
    let accepted_configuration = store.state.calls["offer"].session_configuration.clone();
    let (control, mut commands) = mpsc::channel::<SidebandCommand>(1);
    let controls = BTreeMap::from([("rtc_fixture".into(), control)]);
    let (_events, mut incoming) = mpsc::channel(1);
    let update = |id: &str, state: &str| SessionUpdate { call_id: "rtc_fixture".into(), correlation_id: "offer".into(), update_id: id.into(), delegation_id: None, channel: UpdateChannel::Context, text: String::new(), client_context: Some(context(state)) };
    for protocol in [LiveProtocol::CodexLive, LiveProtocol::OpenaiLive] {
        assert!(update_frames(protocol, &update("first", "visible")).unwrap_err().contains("delegation metadata"));
    }
    config.transport.request_timeout_ms = Some(10);
    let first = update("first", "visible");
    update_call(&config, &mut store, &controls, &mut incoming, first.clone(), "first".into()).await.unwrap();
    assert_eq!(store.state.calls["offer"].client_context, first.client_context);
    update_call(&config, &mut store, &controls, &mut incoming, update("second", "removed"), "second".into()).await.unwrap();
    store = Store::open(root.path(), 1_048_576).unwrap();
    update_call(&config, &mut store, &controls, &mut incoming, first, "first".into()).await.unwrap();
    assert!(update_call(&config, &mut store, &controls, &mut incoming, update("first", "hidden"), "changed".into()).await.unwrap_err().contains("different content"));
    let mut mixed = update("mixed", "hidden"); mixed.text = "Do something".into();
    assert!(update_call(&config, &mut store, &controls, &mut incoming, mixed, "mixed".into()).await.unwrap_err().contains("no text"));
    assert!(commands.try_recv().is_err(), "client metadata must never enter the voice connection");
    assert_eq!(store.state.calls["offer"].status, "attached");
    assert_eq!(store.state.calls["offer"].session_configuration, accepted_configuration);
    assert_eq!(store.state.calls["offer"].updates.len(), 2);
    assert!(store.state.pending.iter().all(|item| item.body["status"] == "context_retained"));
    let restored = Store::open(root.path(), 1_048_576).unwrap();
    assert_eq!(restored.state.calls["offer"].client_context, Some(context("removed")));
    for protocol in [LiveProtocol::CodexLive, LiveProtocol::OpenaiLive] {
        let mut call = restored.state.calls["offer"].clone();
        let event = if protocol == LiveProtocol::CodexLive { json!({"type":"delegation.created","item":{"id":"B","type":"delegation","target":"client","content":[{"type":"input_text","text":"Show it"}]}}) }
            else { json!({"type":"session.delegation.created","delegation":{"id":"B","target":"client"}}) };
        let output = accept_event(protocol, &mut call, &event, 1_048_576).unwrap();
        assert_eq!(output.last().unwrap().1["client_context"], json!(context("removed")));
        call.client_context = Some(context("visible"));
        assert_eq!(output.last().unwrap().1["client_context"], json!(context("removed")));
    }
    let mut oversized = context("visible"); oversized[0].text = "é".repeat(2049);
    assert!(crate::client_context::validate(Some(&oversized)).is_err());
    unsafe { std::env::remove_var(key); }
}

#[test]
fn both_protocols_preserve_full_duplex_transcripts_and_exact_delegation() {
    for protocol in [LiveProtocol::CodexLive, LiveProtocol::OpenaiLive] {
        let mut call = call();
        let delta = |role: &str, id: &str, text: &str| {
            if protocol == LiveProtocol::CodexLive {
                json!({"type":if role=="user"{"input_transcript.added"}else{"output_transcript.added"},"event_id":id,"item":{"text":text}})
            } else {
                json!({"type":if role=="user"{"session.input_transcript.delta"}else{"session.output_transcript.delta"},"event_id":id,"delta":text,"start_ms":100,"end_ms":200})
            }
        };
        let first =
            accept_event(protocol, &mut call, &delta("user", "u1", "Do "), 1_000_000).unwrap();
        let assistant = accept_event(
            protocol,
            &mut call,
            &delta("assistant", "a1", "Okay"),
            1_000_000,
        )
        .unwrap();
        let more = accept_event(
            protocol,
            &mut call,
            &delta("user", "u2", "this this"),
            1_000_000,
        )
        .unwrap();
        assert_eq!(first[0].1["id"], more[0].1["id"]);
        assert_ne!(first[0].1["id"], assistant[0].1["id"]);
        assert_eq!(more[0].1["text"], "Do this this");
        assert_eq!(more[0].1["final"], false);
        assert!(accept_event(
            protocol,
            &mut call,
            &delta("user", "u2", "this this"),
            1_000_000
        )
        .unwrap()
        .is_empty());
        let delegation = if protocol == LiveProtocol::CodexLive {
            let done=accept_event(protocol,&mut call,&json!({"type":"turn.done","event_id":"u3","turn":{"role":"user","transcript":"Do this this."}}),1_000_000).unwrap();
            assert_eq!(done[0].1["id"], first[0].1["id"]);
            assert_eq!(done[0].1["final"], true);
            json!({"type":"delegation.created","item":{"id":"work","type":"delegation","target":"client","content":[{"type":"input_text","text":"Do this."}]}})
        } else {
            json!({"type":"session.delegation.created","offset_ms":280,"delegation":{"id":"work","target":"client"}})
        };
        let work = accept_event(protocol, &mut call, &delegation, 1_000_000).unwrap();
        assert!(work.last().unwrap().2);
        assert_eq!(work.last().unwrap().1["delegation_id"], "work");
        if protocol == LiveProtocol::OpenaiLive {
            assert_eq!(work[0].1["provider_turn_complete"], false);
            assert!(work.last().unwrap().1["input_text"].is_null());
        }
        assert!(accept_event(protocol, &mut call, &delegation, 1_000_000)
            .unwrap()
            .is_empty());
    }
}

#[test]
fn transcript_backlog_preserves_prepared_bytes_and_delivers_confirmed_closure_first() {
    for protocol in [LiveProtocol::CodexLive, LiveProtocol::OpenaiLive] {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path(), 1_048_576).unwrap();
        store.state.calls.insert("offer".into(), call());
        let config = config("http://127.0.0.1:1/live", "ws://127.0.0.1:1/live", protocol);
        let delta = |role: &str, index: usize| SidebandEvent {
            call_id: "rtc_fixture".into(),
            event: if protocol == LiveProtocol::CodexLive {
                json!({"type":format!("{}_transcript.added",if role == "user" {"input"} else {"output"}),"event_id":format!("{role}{index}"),"item":{"text":"x"}})
            } else {
                json!({"type":format!("session.{}_transcript.delta",if role == "user" {"input"} else {"output"}),"event_id":format!("{role}{index}"),"delta":"x"})
            },
        };
        apply_sideband_event(&config, &mut store, delta("assistant", 0)).unwrap();
        store.state.pending[0].delivery = Some(crate::state::DeliveryIdentity {
            artifact: octopus_ledger::ArtifactRef {
                id: octopus_descriptors::ArtifactId::new("prepared"),
                content: octopus_ledger::ContentHash::of_bytes(b"prepared"),
            },
            outbound: Vec::new(),
        });
        let prepared = serde_json::to_value(&store.state.pending[0]).unwrap();
        let (events, mut incoming) = mpsc::channel(400);
        for index in 1..=200 {
            for role in ["user", "assistant"] {
                events.try_send(delta(role, index)).unwrap();
            }
        }
        drain_available_events(&config, &mut store, &mut incoming).unwrap();
        assert!(incoming.is_empty());
        let persisted = Store::open(root.path(), 1_048_576).unwrap();
        assert_eq!(persisted.state.calls["offer"].transcript[0].text.len(), 201);
        assert_eq!(persisted.state.calls["offer"].transcript[1].text.len(), 200);
        assert_eq!(persisted.state.pending.len(), 3);
        assert_eq!(store.state.pending.len(), 3);
        queue_refusal(&mut store, 1, "realtime.session.closed", Some(&json!({"correlation_id":"offer","call_id":"rtc_fixture","stop_id":"refused"})), "refused").unwrap();
        assert_eq!(store.state.pending[3].body["remote_closed"], false);
        store.state.pending.pop();
        apply_sideband_event(&config, &mut store, SidebandEvent {
            call_id: "rtc_fixture".into(), event: json!({"type":"session.closed"}),
        }).unwrap();
        store.save().unwrap();
        let restored = Store::open(root.path(), 1_048_576).unwrap();
        assert_eq!(serde_json::to_value(&restored.state.pending[0]).unwrap(), prepared);
        assert_eq!(restored.state.pending.len(), 4);
        let closed = &restored.state.pending[1];
        assert_eq!(closed.label, "realtime.session.closed");
        assert_eq!(closed.body["remote_closed"], true);
        assert_eq!(closed.body["transcript"], serde_json::to_value(&restored.state.calls["offer"].transcript).unwrap());
        for entry in &restored.state.pending[2..] {
            assert_eq!(entry.body["final"], true);
            assert_eq!(entry.body["text"].as_str().unwrap().len(), if entry.body["role"] == "assistant" {201} else {200});
        }
    }
}

#[test]
fn strict_config_and_utf8_updates_do_not_select_models_or_rewrite_channels() {
    let config = config(
        "http://127.0.0.1:1/live",
        "ws://127.0.0.1:1/live",
        LiveProtocol::CodexLive,
    );
    assert!(merge_session(
        &config.private.session,
        &json!({"model":"hidden"}),
        "selected"
    )
    .is_err());
    assert!(merge_session(
        &config.private.session,
        &json!({"delegation":{"type":"responses"}}),
        "selected"
    )
    .is_err());
    let mut update = SessionUpdate {
        call_id: "rtc_fixture".into(),
        correlation_id: "offer".into(),
        update_id: "result".into(),
        delegation_id: Some("work".into()),
        channel: UpdateChannel::Context,
        text: "é".repeat(401),
        client_context: None,
    };
    let frames = update_frames(LiveProtocol::CodexLive, &update).unwrap();
    assert_eq!(frames.len(), 2);
    assert!(frames
        .iter()
        .all(|f| f["channel"] == "commentary" && f.get("event_id").is_none()));
    assert_eq!(
        frames
            .iter()
            .map(|f| f["content"][0]["text"].as_str().unwrap())
            .collect::<String>(),
        update.text
    );
    update.channel = UpdateChannel::Commentary;
    assert_eq!(
        update_frames(LiveProtocol::CodexLive, &update).unwrap().last().unwrap()["channel"],
        "speakable"
    );
    let spoken = update_frames(LiveProtocol::CodexLive, &update).unwrap();
    assert!(spoken.iter().all(|frame| frame["channel"] == "speakable" && frame["delegation_item_id"] == "work"));
    assert_eq!(spoken.iter().map(|frame| frame["content"][0]["text"].as_str().unwrap()).collect::<String>(), update.text);
    update.channel = UpdateChannel::Instructions;
    assert!(update_frames(LiveProtocol::CodexLive, &update).is_err());
    assert_eq!(
        update_frames(LiveProtocol::OpenaiLive, &update).unwrap()[0]["type"],
        "session.instructions.append"
    );
    assert_eq!(
        decode_call_id("/v1/realtime/calls/rtc_exact").unwrap(),
        "rtc_exact"
    );
    assert!(decode_call_id("/v1/realtime/calls").is_err());
    assert!(crate::wire::validate_endpoint("http://localhost:0/realtime/calls", false).is_err());
    assert!(
        crate::wire::validate_endpoint("https://user:secret@example.org/calls", false).is_err()
    );
}

#[tokio::test]
async fn http_and_sideband_contracts_preserve_call_and_operation_identity() {
    unsafe {
        std::env::set_var(
            "OCTOPUS_REALTIME_CONTRACT_TEST_BEARER",
            "fixture-bearer-value",
        );
    }
    for protocol in [LiveProtocol::CodexLive, LiveProtocol::OpenaiLive] {
        let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_url = format!("http://{}/live", http.local_addr().unwrap());
        let ws_url = format!("ws://{}/live", ws.local_addr().unwrap());
        let http_task = tokio::spawn(async move {
            let (mut socket, _) = http.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0u8; 4096];
            let offset = loop {
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(i) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let headers = String::from_utf8(bytes[..offset].to_vec()).unwrap();
            assert!(headers
                .to_lowercase()
                .contains("authorization: bearer fixture-bearer-value"));
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            while bytes.len() < offset + length {
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
            }
            let body: Value = serde_json::from_slice(&bytes[offset..]).unwrap();
            assert_eq!(body["session"]["model"], "gpt-live-1-codex");
            assert_eq!(body["session"]["delegation"]["type"], "client");
            assert_eq!(body["session"]["audio"]["output"]["voice"], "ember");
            assert_eq!(body["session"]["instructions"], "Custom accepted voice instructions");
            assert!(body["session"].get("id").is_none());
            if protocol == LiveProtocol::CodexLive {
                assert!(headers.contains("intent=quicksilver&architecture=avas"));
                assert!(headers
                    .to_lowercase()
                    .contains("openai-alpha: quicksilver=v2"));
                assert_eq!(body["sdp"], "v=0\r\n");
                assert_eq!(
                    body["session"]["initial_items"][0]["content"][0]["type"],
                    "output_text"
                );
            } else {
                assert_eq!(body["transport"]["type"], "webrtc");
                assert_eq!(body["transport"]["sdp"], "v=0\r\n");
                assert!(body["session"].get("initial_items").is_none());
                assert!(body["session"].get("input").is_some());
            }
            let body = if protocol == LiveProtocol::CodexLive {
                "v=0\r\na=answer\r\n".into()
            } else {
                json!({"session":{"id":"rtc_fixture"},"transport":{"type":"webrtc","sdp":"v=0\r\na=answer\r\n"}}).to_string()
            };
            let answer=format!("HTTP/1.1 201 Created\r\nLocation: /v1/live/rtc_fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
            socket.write_all(answer.as_bytes()).await.unwrap();
        });
        let socket_task = tokio::spawn(async move {
            let (mut inactive, _) = ws.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            inactive.read(&mut request).await.unwrap();
            inactive.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            drop(inactive);
            let (stream, _) = ws.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                stream,
                move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                      response| {
                    assert_eq!(
                        request.uri().path(),
                        if protocol == LiveProtocol::CodexLive {
                            "/live/rtc_fixture"
                        } else {
                            "/live/rtc_fixture/attach"
                        }
                    );
                    if protocol == LiveProtocol::CodexLive {
                        assert_eq!(request.headers()["openai-alpha"], "quicksilver=v2");
                    }
                    assert_eq!(
                        request.headers()["authorization"],
                        "Bearer fixture-bearer-value"
                    );
                    Ok(response)
                },
            )
            .await
            .unwrap();
            socket.send(Message::Text(json!({"type":"session.started"}).to_string().into())).await.unwrap();
            let update: Value =
                serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            assert_eq!(
                update["type"],
                if protocol == LiveProtocol::CodexLive {
                    "delegation.context.append"
                } else {
                    "session.commentary.append"
                }
            );
            let close: Value =
                serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            assert_eq!(close["type"], "session.close");
            let tail = if protocol == LiveProtocol::CodexLive {
                json!({"type":"turn.done","turn":{"role":"assistant","transcript":"Final words"}})
            } else {
                json!({"type":"session.output_transcript.delta","delta":"Final words","start_ms":400,"end_ms":500})
            };
            socket
                .send(Message::Text(tail.to_string().into()))
                .await
                .unwrap();
            socket
                .send(Message::Text(
                    json!({"type":"session.closed","event_id":"closed"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        });
        let config = config(&http_url, &ws_url, protocol);
        if protocol == LiveProtocol::CodexLive {
            let client = LiveClient::connect(&config).await.unwrap();
            let invalid = merge_session(&config.private.session, &json!({"initial_items":[{
                "type":"message","role":"developer","content":[
                    {"type":"input_text","text":"First"},{"type":"input_text","text":"Second"}]}]}), &config.private.model).unwrap();
            let refusal = client.open_call("v=0\r\n", &invalid).await.err().unwrap();
            assert!(matches!(refusal.creation_disposition, crate::wire::CreationDisposition::NotCreated));
            assert!(refusal.error.contains("exactly one text content part"));
            let mut missing_selector = config.clone();
            missing_selector.transport.headers.clear();
            assert!(LiveClient::connect(&missing_selector)
                .await
                .err()
                .unwrap()
                .contains("OpenAI-Alpha"));
        }
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path(), 1_048_576).unwrap();
        let mut controls = BTreeMap::new();
        let (events, mut rx) = mpsc::channel(128);
        let offer = SessionOffer {
            offer_sdp: "v=0\r\n".into(),
            correlation_id: "offer".into(),
            delegation_interface: "home_provider".into(),
            session: json!({"instructions":"Custom accepted voice instructions","initial_items":[{"type":"message","role":"assistant","content":[{"type":"input_text","text":"Prior reply"}]}]}),
            client_context: Some(vec![crate::ClientContextEntry { name: "client_observation".into(), text: "{\"widgets\":[]}".into() }]),
        };
        offer_call(
            &config,
            &mut store,
            &mut controls,
            &events,
            offer.clone(),
            "same".into(),
            1,
        )
        .await
        .unwrap();
        let retained = store.state.calls["offer"].session_configuration.as_ref().unwrap();
        assert_eq!(retained["instructions"], "Custom accepted voice instructions");
        assert_eq!(retained["audio"], config.private.session["audio"]);
        assert!(retained.get("initial_items").is_none()); assert!(retained.get("model").is_none());
        assert_eq!(
            store.state.calls["offer"].answer.as_ref().unwrap()["sideband_connected"],
            false
        );
        offer_call(
            &config,
            &mut store,
            &mut controls,
            &events,
            offer.clone(),
            "same".into(),
            1,
        )
        .await
        .unwrap();
        assert!(offer_call(
            &config,
            &mut store,
            &mut controls,
            &events,
            offer,
            "different".into(),
            1
        )
        .await
        .is_err());
        let activated = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.unwrap().unwrap();
        apply_sideband_events(&config, &mut store, [activated]).unwrap();
        assert_eq!(store.state.calls["offer"].status, "attached");
        let observation = SessionUpdate {
            call_id: "rtc_fixture".into(), correlation_id: "offer".into(),
            update_id: "client-observation".into(), delegation_id: None,
            channel: UpdateChannel::Context, text: String::new(),
            client_context: Some(vec![crate::ClientContextEntry {
                name: "client_observation".into(), text: "{\"widgets\":[\"visible\"]}".into(),
            }]),
        };
        update_call(&config, &mut store, &controls, &mut rx, observation.clone(), "observation-digest".into()).await.unwrap();
        assert_eq!(store.state.calls["offer"].client_context, observation.client_context);
        assert_eq!(store.state.calls["offer"].updates["client-observation"].result.as_ref().unwrap()["status"], "context_retained");
        store
            .state
            .calls
            .get_mut("offer")
            .unwrap()
            .delegations
            .insert("work".into());
        let update = SessionUpdate {
            call_id: "rtc_fixture".into(),
            correlation_id: "offer".into(),
            update_id: "result".into(),
            delegation_id: Some("work".into()),
            channel: UpdateChannel::Commentary,
            text: "Verified result".into(),
            client_context: None,
        };
        update_call(
            &config,
            &mut store,
            &controls,
            &mut rx,
            update.clone(),
            "update-digest".into(),
        )
        .await
        .unwrap();
        update_call(
            &config,
            &mut store,
            &controls,
            &mut rx,
            update,
            "update-digest".into(),
        )
        .await
        .unwrap();
        stop_call(
            &config,
            &mut store,
            &mut controls,
            &events,
            &mut rx,
            SessionStop {
                call_id: "rtc_fixture".into(),
                correlation_id: "offer".into(),
                stop_id: "stop".into(),
            },
            "stop-digest".into(),
        )
        .await
        .unwrap();
        let replay = Store::open(root.path(), 1_048_576).unwrap();
        assert_eq!(
            replay.state.calls["offer"].stops["stop"]
                .result
                .as_ref()
                .unwrap()["remote_closed"],
            true
        );
        let closed = replay.state.calls["offer"].stops["stop"]
            .result
            .as_ref()
            .unwrap();
        assert_eq!(closed["transcript"][0]["text"], "Final words");
        assert_eq!(closed["transcript"][0]["complete"], true);
        assert!(
            !std::fs::read_to_string(root.path().join("voice-state.json"))
                .unwrap()
                .contains("fixture-bearer-value")
        );
        tokio::time::timeout(Duration::from_secs(3), http_task)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), socket_task)
            .await
            .unwrap()
            .unwrap();
    }
    unsafe {
        std::env::remove_var("OCTOPUS_REALTIME_CONTRACT_TEST_BEARER");
    }
}

#[tokio::test]
async fn command_drains_bounded_events_and_admits_ack_before_local_completion() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path(), 1_048_576).unwrap();
    let mut owner = call();
    owner.updates.insert("context".into(), Operation { digest: "exact".into(), result: None });
    store.state.calls.insert("offer".into(), owner);
    let config = config("http://127.0.0.1:1/live", "ws://127.0.0.1:1/live", LiveProtocol::OpenaiLive);
    let (control, mut commands) = mpsc::channel::<SidebandCommand>(1);
    let (events, mut received) = mpsc::channel(1);
    events.send(SidebandEvent { call_id: "rtc_fixture".into(), event: json!({"type":"session.output_transcript.delta","delta":"Reply"}) }).await.unwrap();
    let producer = tokio::spawn(async move {
        events.send(SidebandEvent { call_id: "rtc_fixture".into(), event: json!({"type":"session.thinking.appended","client_event_id":"context:0"}) }).await.unwrap();
        commands.recv().await.unwrap().completion.send(Ok(false)).unwrap();
    });
    assert!(!send_command_with_events(&config, &mut store, &mut received, &control, Vec::new(), false, Duration::from_secs(1)).await.unwrap());
    producer.await.unwrap();
    assert_eq!(store.state.calls["offer"].status, "attached");
    assert!(store.state.calls["offer"].updates["context"].result.is_none());
    assert_eq!(store.state.pending.last().unwrap().body["status"], "chunk_injected");
    for (label, operation) in [("realtime.session.updated", "update_id"), ("realtime.session.closed", "stop_id")] {
        let request = json!({"correlation_id":"offer","call_id":"rtc_fixture",(operation):"operation"});
        queue_refusal(&mut store, 2, label, Some(&request), "refused").unwrap();
        let receipt = &store.state.pending.last().unwrap().body;
        assert_eq!(receipt["call_id"], "rtc_fixture");
        assert_eq!(receipt[operation], "operation");
        assert_eq!(receipt["ok"], false);
    }
    let owner = store.state.calls.get_mut("offer").unwrap();
    accept_event(LiveProtocol::OpenaiLive, owner, &json!({"type":"octopus.transport.stopped","remote_closed":false}), 1_048_576).unwrap();
    assert_eq!(owner.status, "failed");
    accept_event(LiveProtocol::OpenaiLive, owner, &json!({"type":"session.closed"}), 1_048_576).unwrap();
    assert_eq!(owner.status, "closed");
    assert!(remote_closure_confirmed(&store, "offer", &Err("command transport lost".into())));
    apply_sideband_event(&config, &mut store, SidebandEvent { call_id: "rtc_fixture".into(), event: json!({"type":"session.closed"}) }).unwrap();
    assert!(remote_closure_confirmed(&store, "offer", &Err("command transport lost".into())));
    assert!(!remote_closure_confirmed(&store, "another-call", &Ok(false)));
}

#[tokio::test]
async fn explicit_stop_reattaches_only_the_recorded_call_and_authentication_owner() {
    let key = "OCTOPUS_REALTIME_STOP_TEST_BEARER";
    unsafe { std::env::set_var(key, "fixture-stop-bearer"); }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = config("http://127.0.0.1:1/live", &format!("ws://{}/live", listener.local_addr().unwrap()), LiveProtocol::OpenaiLive);
    config.private.auth = crate::auth::AuthConfig::BearerEnv { env_key: key.into() };
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path(), 1_048_576).unwrap();
    let mut owner = call();
    owner.status = "failed".into();
    owner.auth_owner = Some(config.private.auth.resolve().await.unwrap().owner);
    store.state.calls.insert("offer".into(), owner);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_hdr_async(stream, |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
            assert_eq!(request.uri().path(), "/live/rtc_fixture/attach");
            Ok(response)
        }).await.unwrap();
        let frame: Value = serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(frame["type"], "session.close");
        socket.send(Message::Text(json!({"type":"session.closed"}).to_string().into())).await.unwrap();
    });
    let (events, mut received) = mpsc::channel(1);
    stop_call(&config, &mut store, &mut BTreeMap::new(), &events, &mut received,
        SessionStop { call_id: "rtc_fixture".into(), correlation_id: "offer".into(), stop_id: "explicit-stop".into() }, "stop-digest".into()).await.unwrap();
    server.await.unwrap();
    let receipt = store.state.calls["offer"].stops["explicit-stop"].result.as_ref().unwrap();
    assert_eq!(receipt["sideband_reattached"], true);
    assert_eq!(receipt["remote_closed"], true);
    assert_eq!(receipt["ok"], true);
    unsafe { std::env::set_var(key, "different-fixture-owner"); }
    assert!(attach_stop_control(&config, &store, &events,
        &SessionStop { call_id: "rtc_fixture".into(), correlation_id: "offer".into(), stop_id: "another-stop".into() }).await.unwrap_err().contains("recorded owner"));
    unsafe { std::env::remove_var(key); }
}

#[tokio::test]
async fn call_refusals_keep_bounded_structured_detail_without_credentials() {
    unsafe {
        std::env::set_var("OCTOPUS_REALTIME_ERROR_TEST_BEARER", "fixture-error-secret");
    }
    let mut config = config(
        "http://127.0.0.1:1/live",
        "ws://127.0.0.1:1/live",
        LiveProtocol::CodexLive,
    );
    config.private.auth = crate::auth::AuthConfig::BearerEnv {
        env_key: "OCTOPUS_REALTIME_ERROR_TEST_BEARER".into(),
    };
    let client = LiveClient::connect(&config).await.unwrap();
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("x-request-id", "req_fixture".parse().unwrap());
    let body = json!({"error":{"code":"invalid_value","param":"session.audio.output.voice","type":"invalid_request_error","message":"Unsupported voice"},"request":{"untrusted":"must not be emitted"}});
    let error = client.http_refusal("call", 400, &headers, body.to_string().as_bytes());
    for expected in [
        "HTTP 400",
        "req_fixture",
        "invalid_value",
        "session.audio.output.voice",
        "Unsupported voice",
    ] {
        assert!(error.contains(expected));
    }
    assert!(!error.contains("untrusted"));
    for body in [
        br#"{"error":{"message":"fixture-error-secret"}}"#.as_slice(),
        br#"{"error":{"message":"fixture-error-\u0073ecret"}}"#,
        b"<html>fixture-error-secret</html>",
    ] {
        let error = client.http_refusal("call", 400, &headers, body);
        assert!(error.contains("body withheld"));
        assert!(!error.contains("fixture-error"));
    }
    let body = json!({"detail": format!("bad\n{}", "é".repeat(2048))});
    let error = client.http_refusal("call", 400, &headers, body.to_string().as_bytes());
    assert!(error.len() < 800 && error.contains("bad ") && error.contains("..."));
    assert!(
        !client
            .http_refusal("call", 502, &headers, b"<html>private upstream page</html>")
            .contains("private upstream")
    );
}

#[tokio::test]
async fn invalid_answers_preserve_created_identity_and_request_timeout_stays_unconfirmed() {
    let key = "OCTOPUS_REALTIME_CREATION_FAILURE_FIXTURE";
    unsafe { std::env::set_var(key, "fixture-creation-bearer"); }
    for (protocol, status, location, body, disposition, identity) in [
        (LiveProtocol::CodexLive, 200, "/live/calls/rtc_fixture", "invalid SDP", "created", Some("rtc_fixture")),
        (LiveProtocol::CodexLive, 200, "/live/calls", "v=0", "unconfirmed", None),
        (LiveProtocol::OpenaiLive, 200, "", r#"{"session":{"id":"rtc_fixture"},"transport":{"type":"other"}}"#, "created", Some("rtc_fixture")),
        (LiveProtocol::OpenaiLive, 200, "", r#"{"session":{"id":"rtc_fixture"},"transport":{"type":"webrtc"}}"#, "created", Some("rtc_fixture")),
        (LiveProtocol::OpenaiLive, 200, "", r#"{"session":{"id":"rtc_fixture"},"transport":{"type":"webrtc","sdp":"invalid"}}"#, "created", Some("rtc_fixture")),
        (LiveProtocol::CodexLive, 400, "", "{}", "not_created", None),
        (LiveProtocol::CodexLive, 408, "", "{}", "unconfirmed", None),
        (LiveProtocol::CodexLive, 502, "", "{}", "unconfirmed", None),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/live", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new(); let mut chunk = [0; 4096];
            loop {
                let read = socket.read(&mut chunk).await.unwrap(); assert!(read > 0); request.extend_from_slice(&chunk[..read]);
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let length = headers.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|size| size.trim().parse::<usize>().unwrap())).unwrap();
                    if request.len() >= end + 4 + length { break; }
                }
            }
            let response = format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nLocation: {location}\r\nConnection: close\r\n\r\n{body}", body.len());
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let mut configuration = config(&url, "ws://127.0.0.1:1/live", protocol);
        configuration.private.auth = crate::auth::AuthConfig::BearerEnv { env_key: key.into() };
        let root = tempfile::tempdir().unwrap(); let mut store = Store::open(root.path(), 1_048_576).unwrap();
        let mut controls = BTreeMap::new(); let (events, _) = mpsc::channel(128);
        offer_call(&configuration, &mut store, &mut controls, &events, SessionOffer { offer_sdp: "v=0\r\n".into(), correlation_id: "offer".into(), delegation_interface: "home_provider".into(), session: json!({}), client_context: None }, "digest".into(), 1).await.unwrap();
        let restored = Store::open(root.path(), 1_048_576).unwrap(); let call = &restored.state.calls["offer"];
        assert_eq!(call.call_id.as_deref(), identity); assert_eq!(call.answer.as_ref().unwrap()["creation_disposition"], disposition);
        assert_eq!(call.answer.as_ref().unwrap()["ok"], false); assert!(controls.is_empty());
        server.await.unwrap();
    }
}

#[tokio::test]
async fn secure_sideband_uses_explicit_crypto_without_login_initialization() {
    unsafe {
        std::env::set_var("OCTOPUS_REALTIME_TLS_TEST_BEARER", "fixture-tls-secret");
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = config(
        "http://127.0.0.1:1/live",
        &format!("wss://{}/live", listener.local_addr().unwrap()),
        LiveProtocol::CodexLive,
    );
    config.private.auth = crate::auth::AuthConfig::BearerEnv {
        env_key: "OCTOPUS_REALTIME_TLS_TEST_BEARER".into(),
    };
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut record_header = [0; 5];
        socket.read_exact(&mut record_header).await.unwrap();
        assert_eq!(&record_header[..2], &[0x16, 0x03]);
    });
    let client = LiveClient::connect(&config).await.unwrap();
    let (events, _) = mpsc::channel(1);
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        client.attach("rtc_tls_fixture", events),
    )
    .await
    .unwrap();
    assert_eq!(
        result.err().unwrap(),
        "Live sideband attach transport failed"
    );
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    unsafe {
        std::env::remove_var("OCTOPUS_REALTIME_TLS_TEST_BEARER");
    }
}

#[test]
fn malformed_private_state_fails_closed_and_pending_operations_remain_uncertain() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path(), 1_048_576).unwrap();
    let mut call = call();
    call.updates.insert(
        "pending".into(),
        Operation {
            digest: "original".into(),
            result: None,
        },
    );
    store.state.calls.insert("offer".into(), call);
    store.save().unwrap();
    let mut restored = Store::open(root.path(), 1_048_576).unwrap();
    assert!(restored.state.calls["offer"].updates["pending"]
        .result
        .is_none());
    restored.state.calls.get_mut("offer").unwrap().stops.insert(
        "pending-stop".into(),
        Operation {
            digest: "stop".into(),
            result: None,
        },
    );
    recover_uncertain_operations(&mut restored, "offer").unwrap();
    assert_eq!(restored.state.calls["offer"].status, "failed");
    assert_eq!(
        restored.state.calls["offer"].updates["pending"]
            .result
            .as_ref()
            .unwrap()["status"],
        "uncertain"
    );
    assert_eq!(
        restored.state.calls["offer"].stops["pending-stop"]
            .result
            .as_ref()
            .unwrap()["remote_closed"],
        false
    );
    std::fs::write(root.path().join("voice-state.json"), b"malformed").unwrap();
    assert!(Store::open(root.path(), 1_048_576).is_err());
}

#[test]
fn recording_receipt_accepts_only_reference_evidence_even_after_closure() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path(), 1_048_576).unwrap();
    let mut call = call();
    call.status = "closed".into();
    store.state.calls.insert("offer".into(), call);
    let mut recording: SessionRecording = serde_json::from_value(json!({
        "schema":"octopus.voice_recording","schema_version":1,"correlation_id":"offer",
        "started_at":"2026-10-04T00:00:00.000Z","media":{"path":"/not-opened/recording.webm","mime_type":"audio/webm;codecs=opus","content_hash":"a".repeat(64),"size":128}
    })).unwrap();
    let receipt = recording_receipt(&store, &recording).unwrap();
    assert_eq!(receipt["evidence_only"], true);
    assert_eq!(receipt["media_verified_by_provider"], false);
    assert_eq!(receipt["heard_audio"], false);
    assert!(store.state.pending.is_empty());
    recording.media.content_hash = "bad".into();
    assert!(recording_receipt(&store, &recording).is_err());
    recording.media.content_hash = "a".repeat(64);
    recording.correlation_id = "another-call".into();
    assert!(recording_receipt(&store, &recording).is_err());
}

#[test]
fn socket_closure_does_not_claim_remote_finalization_or_command_success() {
    let mut call = call();
    accept_event(
        LiveProtocol::OpenaiLive,
        &mut call,
        &json!({"type":"session.output_transcript.delta","delta":"partial"}),
        1_048_576,
    )
    .unwrap();
    let events = accept_event(LiveProtocol::OpenaiLive,&mut call,&json!({"type":"octopus.transport.stopped","provider_close_sent":false,"remote_closed":false}),1_048_576).unwrap();
    assert_eq!(events.last().unwrap().1["remote_closed"], false);
    assert_eq!(events.last().unwrap().1["transcript"][0]["complete"], true);
    let mut call = self::call();
    call.updates.insert(
        "u".into(),
        Operation {
            digest: "d".into(),
            result: Some(json!({"status":"transport_written"})),
        },
    );
    let ack = accept_event(
        LiveProtocol::OpenaiLive,
        &mut call,
        &json!({"type":"session.thinking.appended","client_event_id":"u:0"}),
        1_048_576,
    )
    .unwrap();
    assert_eq!(ack[0].1["status"], "chunk_injected");
    assert_eq!(ack[0].1["heard_audio"], false);
    let before = serde_json::to_value(&call).unwrap();
    assert!(accept_event(LiveProtocol::OpenaiLive, &mut call,
        &json!({"type":"session.thinking.appended","event_id":"bad_chunk","client_event_id":"u:not_a_chunk"}), 1_048_576).is_err());
    assert_eq!(serde_json::to_value(&call).unwrap(), before);
}

#[tokio::test]
async fn confirmed_closure_survives_delivery_restart_and_interrupted_stop() {
    let config = config(
        "http://127.0.0.1:1/live",
        "ws://127.0.0.1:1/live",
        LiveProtocol::OpenaiLive,
    );
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path(), 1_048_576).unwrap();
    store.state.calls.insert("offer".into(), call());
    let (events, mut received) = mpsc::channel(1);
    let retry = SessionStop {
        call_id: "rtc_fixture".into(),
        correlation_id: "offer".into(),
        stop_id: "initially_unconfirmed".into(),
    };
    stop_call(
        &config,
        &mut store,
        &mut BTreeMap::new(),
        &events,
        &mut received,
        retry.clone(),
        "retry-digest".into(),
    )
    .await
    .unwrap();
    assert_eq!(
        store.state.calls["offer"].stops["initially_unconfirmed"]
            .result
            .as_ref()
            .unwrap()["remote_closed"],
        false
    );
    apply_sideband_event(
        &config,
        &mut store,
        SidebandEvent {
            call_id: "rtc_fixture".into(),
            event: json!({"type":"session.closed","event_id":"provider_closed"}),
        },
    )
    .unwrap();
    store.state.pending.clear();
    store.save().unwrap();
    let mut store = Store::open(root.path(), 1_048_576).unwrap();
    assert!(remote_closure_confirmed(
        &store,
        "offer",
        &Err("completion lost".into())
    ));
    stop_call(
        &config,
        &mut store,
        &mut BTreeMap::new(),
        &events,
        &mut received,
        retry,
        "retry-digest".into(),
    )
    .await
    .unwrap();
    assert_eq!(
        store.state.calls["offer"].stops["initially_unconfirmed"]
            .result
            .as_ref()
            .unwrap()["remote_closed"],
        true
    );
    for event in [
        json!({"type":"octopus.transport.connected"}),
        json!({"type":"octopus.transport.stopped","remote_closed":false}),
        json!({"type":"error","error":{"message":"stale error"}}),
    ] {
        assert!(accept_event(
            LiveProtocol::OpenaiLive,
            store.state.calls.get_mut("offer").unwrap(),
            &event,
            1_048_576
        )
        .unwrap()
        .is_empty());
        assert_eq!(store.state.calls["offer"].status, "closed");
    }
    store.state.calls.get_mut("offer").unwrap().stops.insert(
        "interrupted".into(),
        Operation {
            digest: "interrupted-digest".into(),
            result: None,
        },
    );
    recover_uncertain_operations(&mut store, "offer").unwrap();
    assert_eq!(
        store.state.calls["offer"].stops["interrupted"]
            .result
            .as_ref()
            .unwrap()["remote_closed"],
        true
    );
    let (events, mut received) = mpsc::channel(1);
    stop_call(
        &config,
        &mut store,
        &mut BTreeMap::new(),
        &events,
        &mut received,
        SessionStop {
            call_id: "rtc_fixture".into(),
            correlation_id: "offer".into(),
            stop_id: "after_delivery".into(),
        },
        "after-delivery-digest".into(),
    )
    .await
    .unwrap();
    let receipt = store.state.calls["offer"].stops["after_delivery"]
        .result
        .as_ref()
        .unwrap();
    assert_eq!(receipt["ok"], true);
    assert_eq!(receipt["remote_closed"], true);
    assert_eq!(receipt["provider_close_sent"], false);
    assert_eq!(receipt["sideband_reattached"], false);
    let mut wrong_call = call();
    wrong_call.stops = store.state.calls["offer"].stops.clone();
    wrong_call.call_id = Some("rtc_other".into());
    assert!(!wrong_call.remote_closed());
}

#[test]
fn rejected_transcript_events_do_not_mutate_bytes_or_consume_provider_identity() {
    for protocol in [LiveProtocol::CodexLive, LiveProtocol::OpenaiLive] {
        let mut owner = call();
        let delta = |id: &str, text: &str| {
            if protocol == LiveProtocol::CodexLive {
                json!({"type":"input_transcript.added","event_id":id,"item":{"text":text}})
            } else {
                json!({"type":"session.input_transcript.delta","event_id":id,"delta":text})
            }
        };
        accept_event(protocol, &mut owner, &delta("first", "éé"), 8).unwrap();
        let before = serde_json::to_value(&owner).unwrap();
        assert!(accept_event(protocol, &mut owner, &delta("overflow", "ééé"), 8).is_err());
        assert_eq!(serde_json::to_value(&owner).unwrap(), before);
        accept_event(protocol, &mut owner, &delta("overflow", "éé"), 8).unwrap();
        assert_eq!(owner.transcript[0].text, "éééé");
        if protocol == LiveProtocol::CodexLive {
            let before = serde_json::to_value(&owner).unwrap();
            assert!(accept_event(protocol, &mut owner, &json!({"type":"turn.done","event_id":"final","turn":{"role":"user","transcript":"ééééé"}}), 8).is_err());
            assert_eq!(serde_json::to_value(&owner).unwrap(), before);
            accept_event(protocol, &mut owner, &json!({"type":"turn.done","event_id":"final","turn":{"role":"user","transcript":"Done"}}), 8).unwrap();
            assert_eq!(owner.transcript[0].text, "Done");
            assert!(owner.transcript[0].complete);
        }
    }
}

#[tokio::test]
async fn cancellation_closes_all_calls_concurrently_and_keeps_confirmation_separate() {
    let config = config(
        "http://127.0.0.1:1/live",
        "ws://127.0.0.1:1/live",
        LiveProtocol::OpenaiLive,
    );
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path(), 1_048_576).unwrap();
    store.state.calls.insert("offer".into(), call());
    let mut other = call();
    other.correlation_id = "other".into();
    other.call_id = Some("rtc_other".into());
    store.state.calls.insert("other".into(), other);
    let (first, mut first_rx) = mpsc::channel::<SidebandCommand>(1);
    let (second, mut second_rx) = mpsc::channel::<SidebandCommand>(1);
    let controls = BTreeMap::from([("rtc_fixture".into(), first), ("rtc_other".into(), second)]);
    let (events, mut received) = mpsc::channel(1);
    let producer = tokio::spawn(async move {
        let first = first_rx.recv().await.unwrap();
        let second = second_rx.recv().await.unwrap();
        assert!(first.close && second.close);
        events
            .send(SidebandEvent {
                call_id: "rtc_other".into(),
                event: json!({"type":"session.closed"}),
            })
            .await
            .unwrap();
        first.completion.send(Ok(false)).unwrap();
        second.completion.send(Ok(false)).unwrap();
    });
    tokio::time::timeout(
        Duration::from_secs(1),
        close_controls(&config, &mut store, controls, &mut received),
    )
    .await
    .unwrap()
    .unwrap();
    producer.await.unwrap();
    assert_eq!(store.state.calls["offer"].status, "failed");
    assert_eq!(store.state.calls["other"].status, "closed");
    assert!(store
        .state
        .pending
        .iter()
        .any(|entry| entry.correlation_id.as_deref() == Some("offer")
            && entry.body["remote_closed"] == false));
    assert!(store
        .state
        .pending
        .iter()
        .any(|entry| entry.correlation_id.as_deref() == Some("other")
            && entry.body["remote_closed"] == true));
    store.state.calls.get_mut("other").unwrap().call_id = Some("rtc_fixture".into());
    assert!(apply_sideband_event(
        &config,
        &mut store,
        SidebandEvent {
            call_id: "rtc_fixture".into(),
            event: json!({"type":"session.closed"})
        }
    )
    .unwrap_err()
    .contains("unique exact"));
    assert_eq!(store.state.calls["offer"].status, "failed");
}

#[test]
fn a_closed_call_hands_its_final_transcript_once_where_the_run_routes_it() {
    for protocol in [LiveProtocol::CodexLive, LiveProtocol::OpenaiLive] {
        for routed in [true, false] {
            let mut call = call();
            call.hands_transcript = routed;
            let said = if protocol == LiveProtocol::CodexLive {
                json!({"type":"input_transcript.added","event_id":"u1","item":{"text":"Remember OCELOT"}})
            } else {
                json!({"type":"session.input_transcript.delta","event_id":"u1","delta":"Remember OCELOT"})
            };
            accept_event(protocol, &mut call, &said, 1_000_000).unwrap();
            let closed = accept_event(protocol, &mut call, &json!({"type":"session.closed"}), 1_000_000).unwrap();
            let handed = closed.iter().filter(|(label, _, _)| label == "realtime.call.transcript").collect::<Vec<_>>();
            if routed {
                let [(_, body, delegated)] = handed.as_slice() else { panic!("one call transcript expected") };
                assert!(*delegated);
                assert_eq!(body["call_id"], "rtc_fixture");
                assert_eq!(body["transcript"][0]["text"], "Remember OCELOT");
                assert_eq!(body["transcript"][0]["complete"], true);
            } else {
                assert!(handed.is_empty());
            }
            let stopped = accept_event(protocol, &mut call, &json!({"type":"octopus.transport.stopped","remote_closed":true}), 1_000_000).unwrap();
            assert!(stopped.iter().all(|(label, _, _)| label != "realtime.call.transcript"));
        }
    }
}
