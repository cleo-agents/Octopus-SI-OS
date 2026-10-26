use octopus_provider_claude_native::{InflightTurn, Journal, PendingCallRecord, QueuedContext};

#[test]
fn a_journal_keeps_the_session_and_the_turn_in_flight_across_lives() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut journal = Journal::open(dir.path(), 64 * 1024).unwrap();
        assert_eq!(journal.claude_session_id("run_a"), None);
        journal.record_session("run_a", "claude-1").unwrap();
        journal.record_inflight("run_a", Some(InflightTurn { source_seq: 7, turn: "source-7".into(), reply_to: None, pending_call: None })).unwrap();
        journal
            .record_inflight(
                "run_a",
                Some(InflightTurn {
                    source_seq: 7,
                    turn: "source-7".into(),
                    reply_to: Some(serde_json::json!({"id": "operator.message:abc"})),
                    pending_call: Some(PendingCallRecord { call_id: "call-1".into(), tool: "artifact.list".into() }),
                }),
            )
            .unwrap();
        journal.record_handled_control(40).unwrap();
        journal.record_handled_control(40).unwrap();
    }
    let journal = Journal::open(dir.path(), 64 * 1024).unwrap();
    assert_eq!(journal.claude_session_id("run_a").as_deref(), Some("claude-1"));
    let inflight = journal.inflight("run_a").unwrap();
    assert_eq!(inflight.source_seq, 7);
    assert_eq!(inflight.pending_call.as_ref().map(|call| call.call_id.as_str()), Some("call-1"));
    assert_eq!(inflight.reply_to.as_ref().and_then(|value| value["id"].as_str()), Some("operator.message:abc"));
    assert!(journal.control_handled(40));
    assert!(!journal.control_handled(41));
    let restored: Vec<_> = journal.runs().filter(|(_, entry)| entry.inflight.is_some()).map(|(run, _)| run.clone()).collect();
    assert_eq!(restored, ["run_a"]);
}

#[test]
fn a_journal_written_before_turns_were_recorded_still_opens() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("claude-native-journal.json"),
        br#"{"version":1,"runs":{"run_old":{"claude_session_id":"claude-0"}}}"#,
    )
    .unwrap();
    let journal = Journal::open(dir.path(), 64 * 1024).unwrap();
    assert_eq!(journal.claude_session_id("run_old").as_deref(), Some("claude-0"));
    assert!(journal.inflight("run_old").is_none());
    assert!(!journal.control_handled(1));
}

#[test]
fn queued_context_waits_for_the_next_turn_across_lives() {
    let dir = tempfile::tempdir().unwrap();
    let transcript = QueuedContext { artifact: serde_json::json!({"id": "realtime.call.transcript:a"}), text: "OCELOT".into() };
    {
        let mut journal = Journal::open(dir.path(), 64 * 1024).unwrap();
        journal.queue_context("run_a", transcript.clone()).unwrap();
        journal.queue_context("run_a", transcript.clone()).unwrap();
    }
    let mut journal = Journal::open(dir.path(), 64 * 1024).unwrap();
    assert_eq!(journal.queued_context("run_a"), vec![transcript.clone()]);
    assert!(journal.queued_context("run_b").is_empty());
    journal.take_queued_context("run_a", &[transcript]).unwrap();
    assert!(Journal::open(dir.path(), 64 * 1024).unwrap().queued_context("run_a").is_empty());
}

#[test]
fn queued_context_is_bounded_and_a_refused_entry_is_not_kept() {
    let dir = tempfile::tempdir().unwrap();
    let mut journal = Journal::open(dir.path(), 64 * 1024).unwrap();
    let entry = |index: usize| QueuedContext { artifact: serde_json::json!({"id": format!("call:{index}")}), text: "said".into() };
    for index in 0..16 {
        journal.queue_context("run_a", entry(index)).unwrap();
    }
    assert!(journal.queue_context("run_a", entry(16)).is_err());
    assert_eq!(journal.queued_context("run_a").len(), 16);
    let mut small = Journal::open(tempfile::tempdir().unwrap().path(), 256).unwrap();
    let large = QueuedContext { artifact: serde_json::json!({"id": "call:large"}), text: "x".repeat(1024) };
    assert!(small.queue_context("run_a", large).is_err());
    assert!(small.queued_context("run_a").is_empty());
}
