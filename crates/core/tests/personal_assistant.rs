use base64::Engine as _;
use project_assistant_core::{Engine, Request};
use serde_json::{json, Value};

fn call(engine: &Engine, command: &str, payload: Value) -> Value {
    engine
        .execute(Request {
            command: command.into(),
            payload,
        })
        .unwrap()
}

#[test]
fn asking_without_confirmed_memory_does_not_require_or_call_a_model() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let project = call(&engine, "create_project", json!({"name":"个人项目"}));
    let answer = call(
        &engine,
        "ask_project",
        json!({"projectId":project["id"],"question":"登录审计什么时候交付？"}),
    );
    assert_eq!(answer["grounded"], false);
    assert_eq!(answer["citations"], json!([]));
    assert_eq!(answer["context"]["projectId"], project["id"]);
    for command in ["_retrieve_qa_context", "_validate_qa_context"] {
        assert_eq!(
            engine
                .execute(Request {
                    command: command.into(),
                    payload: answer["context"].clone(),
                })
                .unwrap_err()
                .code,
            "UNKNOWN_COMMAND"
        );
    }
}

#[test]
fn feishu_binding_must_reference_a_project_and_secrets_are_never_public_or_backed_up() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let mut settings = json!({
        "appId":"cli_fixture_personal", "appSecret":"fixture-secret-never-publish",
        "enabled":false,"pollIntervalSeconds":30,"replyPrefix":"",
        "bindings":[{"chatId":"oc_fixture_group","projectId":"missing","enabled":true}]
    });
    assert_eq!(
        engine
            .execute(Request {
                command: "save_feishu_settings".into(),
                payload: settings.clone(),
            })
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
    let project = call(&engine, "create_project", json!({"name":"飞书群项目"}));
    settings["bindings"][0]["projectId"] = project["id"].clone();
    let saved = call(&engine, "save_feishu_settings", settings.clone());
    assert_eq!(saved["settings"]["hasAppSecret"], true);
    assert!(!saved.to_string().contains("fixture-secret-never-publish"));
    settings.as_object_mut().unwrap().remove("appSecret");
    let updated = call(&engine, "save_feishu_settings", settings);
    assert_eq!(updated["settings"]["hasAppSecret"], true);
    let backup = call(&engine, "create_backup", json!({}));
    let archive = std::fs::File::open(
        directory
            .path()
            .join("backups")
            .join(backup["filename"].as_str().unwrap()),
    )
    .unwrap();
    let mut archive = zip::ZipArchive::new(archive).unwrap();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).unwrap();
        assert!(!entry.name().contains("secrets"));
        assert!(!entry.name().contains("feishu"));
    }
    drop(archive);
    let mut enabled = updated["settings"].clone();
    enabled["enabled"] = json!(true);
    call(&engine, "save_feishu_settings", enabled);
    let bytes = std::fs::read(
        directory
            .path()
            .join("backups")
            .join(backup["filename"].as_str().unwrap()),
    )
    .unwrap();
    call(
        &engine,
        "restore_backup",
        json!({
            "filename":backup["filename"],
            "contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),
            "confirmation":"RESTORE"
        }),
    );
    assert_eq!(
        call(&engine, "get_feishu_status", json!({}))["settings"]["enabled"],
        false
    );
    drop(engine);
    let reopened = Engine::open(directory.path()).unwrap();
    let status = call(&reopened, "get_feishu_status", json!({}));
    assert_eq!(status["settings"]["hasAppSecret"], true);
    assert_eq!(
        status["settings"]["bindings"][0]["projectId"],
        project["id"]
    );
    assert_eq!(status["authorization"]["status"], "disconnected");
}
