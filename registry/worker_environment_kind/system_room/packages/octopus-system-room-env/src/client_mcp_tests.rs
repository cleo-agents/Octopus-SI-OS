use super::*;

fn config() -> Value {
    let descriptor: Value = serde_json::from_str(include_str!("../../../../../tool/client.mcp/tool.json")).unwrap();
    descriptor["handler_config"]["mcp"].clone()
}

#[test]
fn mcp_lifecycle_catalogue_and_exact_calls_are_validated() {
    let mut server = Server::new(&config()).unwrap();
    let list = json!({"jsonrpc":"2.0","id":2,"method":"tools/list"});
    let Reply::Message(before) = server.receive(list.clone()) else { panic!() };
    assert_eq!(before["error"]["code"], -32002);
    let Reply::Message(init) = server.receive(json!({"jsonrpc":"2.0","id":"init","method":"initialize","params":{
        "protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}
    }})) else { panic!() };
    assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
    assert!(matches!(server.receive(json!({"jsonrpc":"2.0","method":"notifications/initialized"})), Reply::Notification));
    let Reply::Message(tools) = server.receive(list) else { panic!() };
    let names = tools["result"]["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect::<Vec<_>>();
    assert_eq!(names, ["list_artifacts","read_artifact","search_artifacts","publish_widget","open_client_surface","open_file","inspect_client","list_widgets","relaunch_client","set_widget"]);
    let call = |name: &str, arguments: Value| json!({"jsonrpc":"2.0","id":"call","method":"tools/call","params":{"name":name,"arguments":arguments}});
    for name in ["list_widgets", "set_widget", "open_file"] {
        let mut action = json!({"schema":"octopus.client_action","schema_version":1,"action":name,"request_id":"widget-request"});
        if name == "set_widget" { action["changes"] = json!([{"widget_id":"builtin.voice.live-context","source_digest":"sha256:exact","state":"visible"}]); }
        if name == "open_file" { action["path"] = json!("/workspace/Report.md"); }
        assert!(matches!(server.receive(call(name, json!({"interface":"target","action":action}))), Reply::Call { .. }));
        action["ambient_path"] = json!("/other-home");
        assert!(matches!(server.receive(call(name, json!({"interface":"target","action":action}))), Reply::Message(value) if value["error"]["code"] == -32602));
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../..");
    let publish = tools["result"]["tools"].as_array().unwrap().iter().find(|entry|entry["name"]=="publish_widget").unwrap();
    for (name, file) in [("client_surface","client_surface_document.schema.json"),("projection_read","projection_read_contract.schema.json")] {
        let schema:Value=serde_json::from_slice(&std::fs::read(root.join("app/schemas").join(file)).unwrap()).unwrap();
        assert_eq!(publish["inputSchema"]["$defs"][name],schema);
    }
    let guide:Value=serde_json::from_slice(&std::fs::read(root.join("registry/artifact/artifact-home-widget-authoring/artifact.json")).unwrap()).unwrap();
    let mut document=guide["contract"]["example"].clone();
    document["glyph"]=json!("cloud");
    let Reply::Message(refused)=server.receive(call("publish_widget",json!({"interface":"target","document":document}))) else {panic!("invalid glyph reached emission")};
    assert_eq!(refused["error"]["code"],-32602);
    assert!(refused["error"]["message"].as_str().unwrap().contains("/document/glyph"));
    document["glyph"]=json!("weather");document["revision"]=json!(2);document["render"]["density"]=json!("comfortable");
    assert!(matches!(server.receive(call("publish_widget",json!({"interface":"target","document":document}))),Reply::Call{..}));
    for source in [
        "https://example.org/photo.jpg", "file:///photo.png", "blob:https://example.org/image",
        "data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,not base64",
    ].into_iter().map(str::to_owned).chain([format!("data:image/png;base64,{}", "A".repeat(524288))]) {
        document["render"]["root"] = json!({"type":"image","source":source,"alt":"Photo"});
        assert!(matches!(server.receive(call("publish_widget", json!({"interface":"target","document":document}))),
            Reply::Message(value) if value["error"]["code"] == -32602), "unsupported image reached emission");
    }
    for source in [
        json!("data:image/avif;base64,YQ=="), json!("data:image/gif;base64,YQ=="),
        json!("data:image/jpeg;base64,YQ=="), json!("data:image/png;base64,YQ=="),
        json!("data:image/webp;base64,YQ=="), json!("DATA:IMAGE/PNG;BASE64,YQ=="),
        json!({"path":"data.photo"}), json!({"path":"sources.photos.0.data_url","fallback":null}),
    ] {
        document["render"]["root"] = json!({"type":"image","source":source,"alt":"Photo"});
        assert!(matches!(server.receive(call("publish_widget", json!({"interface":"target","document":document}))),
            Reply::Call { .. }), "supported image or binding was refused");
    }
    let Reply::Call { id, entry, arguments } = server.receive(call("read_artifact", json!({"id":"visible"}))) else { panic!() };
    assert_eq!(id, "call");
    assert_eq!(entry.name, "read_artifact");
    assert_eq!(arguments, json!({"id":"visible"}));
    for request in [call("read_artifact", json!({"id":"visible","path":"/private"})),
        call("read_artifact", json!({"id":"visible","max_bytes":1})),
        call("unknown", json!({})), call("publish_widget", json!({"interface":"foreign","document":{}})),
        call("open_client_surface", json!({"interface":"target","action":{"schema":"octopus.client_action","schema_version":1,"action":"exec","surface_id":"x"}})),
        json!({"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"file:///private"}}),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/list","params":{"cursor":"old"}})
    ] {
        let Reply::Message(response) = server.receive(request) else { panic!() };
        assert!(response.get("error").is_some(), "{response}");
    }
    let mut duplicate = config();
    let first = duplicate["tools"][0].clone();
    duplicate["tools"].as_array_mut().unwrap().push(first);
    assert!(Server::new(&duplicate).is_err());
    let mut effect = config();
    effect["tools"][0]["operation"]["handler_config"]["operation"] = json!("append");
    assert!(Server::new(&effect).is_err());
}
