//! Independent acceptance tests for the public phase-one application contract.
//!
//! These tests use the same Engine/Request boundary as the desktop and JSONL
//! hosts. Only crash recovery deliberately changes persisted job bookkeeping,
//! to reproduce an interrupted process without a timing-dependent kill.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use project_assistant_core::{Engine, Request};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

fn execute(engine: &Engine, command: &str, payload: Value) -> Value {
    engine
        .execute(Request {
            command: command.into(),
            payload,
        })
        .unwrap_or_else(|error| panic!("{command} failed: {error:?}"))
}

fn expect_error(engine: &Engine, command: &str, payload: Value) {
    let result = engine.execute(Request {
        command: command.into(),
        payload,
    });
    assert!(
        result.is_err(),
        "{command} unexpectedly succeeded: {result:?}"
    );
}

fn project(engine: &Engine, name: &str) -> String {
    execute(engine, "create_project", json!({ "name": name }))["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn wait_for_terminal_source(engine: &Engine, source_id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let source = execute(engine, "get_source", json!({ "sourceId": source_id }));
        match source["source"]["status"].as_str() {
            Some("ready" | "failed") => return source,
            _ => {
                assert!(Instant::now() < deadline, "Import did not finish: {source}");
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

fn wait_for_source(engine: &Engine, source_id: &str) -> Value {
    let source = wait_for_terminal_source(engine, source_id);
    assert_eq!(
        source["source"]["status"], "ready",
        "Import failed: {source}"
    );
    source
}

fn import_text(engine: &Engine, project_id: &str, title: &str, text: &str) -> Value {
    let result = execute(
        engine,
        "import_text",
        json!({ "projectId": project_id, "title": title, "text": text }),
    );
    wait_for_source(engine, result["sourceId"].as_str().unwrap());
    result
}

fn first_segment_id(source: &Value) -> String {
    source["segments"]
        .as_array()
        .expect("segments must be an array")
        .first()
        .expect("import must produce source segments")["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn propose(engine: &Engine, project_id: &str, source_id: &str, content: &str) -> Value {
    let source = wait_for_source(engine, source_id);
    execute(
        engine,
        "create_proposal",
        json!({
            "projectId": project_id,
            "sourceId": source_id,
            "segmentIds": [first_segment_id(&source)],
            "kind": "decision",
            "content": content
        }),
    )
}

fn confirm(engine: &Engine, proposal_id: &str) -> Value {
    execute(
        engine,
        "confirm_proposal",
        json!({ "proposalId": proposal_id }),
    )
}

fn memory(engine: &Engine, memory_id: &str) -> Value {
    execute(engine, "get_memory", json!({ "memoryId": memory_id }))
}

fn backup_bytes(root: &Path, backup: &Value) -> Vec<u8> {
    fs::read(
        root.join("backups")
            .join(backup["filename"].as_str().unwrap()),
    )
    .expect("created backup must exist on disk")
}

fn entries(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).expect("readable ZIP");
    (0..archive.len())
        .filter_map(|index| {
            let mut entry = archive.by_index(index).unwrap();
            if entry.is_dir() {
                return None;
            }
            let name = entry.name().to_owned();
            let mut contents = Vec::new();
            entry.read_to_end(&mut contents).unwrap();
            Some((name, contents))
        })
        .collect()
}

fn archive(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, contents) in entries {
        writer
            .start_file(name, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(contents).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn refresh_manifest_checksums(entries: &mut [(String, Vec<u8>)]) {
    let checksums = entries
        .iter()
        .filter(|(name, _)| name != "manifest.json")
        .map(|(name, bytes)| {
            (
                name.clone(),
                (format!("{:x}", Sha256::digest(bytes)), bytes.len()),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    let manifest_entry = entries
        .iter_mut()
        .find(|(name, _)| name == "manifest.json")
        .unwrap();
    let mut manifest: Value = serde_json::from_slice(&manifest_entry.1).unwrap();
    for file in manifest["files"].as_array_mut().unwrap() {
        let (sha256, size) = &checksums[file["path"].as_str().unwrap()];
        file["sha256"] = json!(sha256);
        file["size"] = json!(size);
    }
    manifest_entry.1 = serde_json::to_vec(&manifest).unwrap();
}

fn alter_backup_database(original_entries: &[(String, Vec<u8>)], sql: &str) -> Vec<u8> {
    let directory = TempDir::new().unwrap();
    let database_path = directory.path().join("fixture.sqlite");
    let mut modified = original_entries.to_vec();
    let database_entry = modified
        .iter_mut()
        .find(|(name, _)| name == "workspace.sqlite")
        .unwrap();
    fs::write(&database_path, &database_entry.1).unwrap();
    let connection = rusqlite::Connection::open(&database_path).unwrap();
    connection.execute_batch(sql).unwrap();
    drop(connection);
    database_entry.1 = fs::read(database_path).unwrap();
    refresh_manifest_checksums(&mut modified);
    archive(&modified)
}

fn backup_payload(bytes: &[u8]) -> Value {
    json!({
        "filename": "workspace-backup.zip",
        "contentBase64": BASE64.encode(bytes),
        "confirmation": "RESTORE"
    })
}

fn one_page_pdf(text: &str) -> Vec<u8> {
    let stream = if text.is_empty() {
        String::new()
    } else {
        format!("BT /F1 12 Tf 20 80 Td ({text}) Tj ET")
    };
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_owned(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
        format!("<< /Length {} >>\nstream\n{}\nendstream", stream.len(), stream),
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref = pdf.len();
    pdf.extend_from_slice(b"xref\n0 6\n0000000000 65535 f \n");
    for offset in offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
    );
    pdf
}

#[test]
fn import_confirm_correct_and_reopen_preserves_history_and_original_evidence() {
    let directory = TempDir::new().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let project_id = project(&engine, "客户 A 上线");
    let original = "客户确认：一期保留单点登录 ✅，验收前由李明复核。";
    let imported = import_text(&engine, &project_id, "需求评审", original);
    let proposal = propose(
        &engine,
        &project_id,
        imported["sourceId"].as_str().unwrap(),
        "一期保留单点登录",
    );
    let confirmed = confirm(&engine, proposal["id"].as_str().unwrap());
    let memory_id = confirmed["id"].as_str().unwrap().to_owned();
    assert_eq!(confirmed["revision"], 1);

    let revised = execute(
        &engine,
        "revise_memory",
        json!({
            "memoryId": memory_id,
            "baseRevision": 1,
            "content": "一期延期单点登录，待客户再次确认",
            "reason": "本人在电话沟通后补充，尚无新的书面依据",
            "segmentIds": []
        }),
    );
    assert_eq!(revised["revision"], 2);
    drop(engine);

    let reopened = Engine::open(directory.path()).unwrap();
    let persisted = memory(&reopened, &memory_id);
    assert_eq!(
        persisted["memory"]["content"],
        "一期延期单点登录，待客户再次确认"
    );
    assert_eq!(persisted["memory"]["revision"], 2);
    let revisions = persisted["revisions"].as_array().unwrap();
    assert_eq!(
        revisions.len(),
        2,
        "correction must retain the old revision"
    );
    let first = revisions
        .iter()
        .find(|revision| revision["number"] == 1)
        .unwrap();
    let second = revisions
        .iter()
        .find(|revision| revision["number"] == 2)
        .unwrap();
    assert_eq!(first["origin"], "confirmation");
    assert_eq!(first["evidence"][0]["text"], original);
    assert_eq!(first["evidence"][0]["sourceTitle"], "需求评审");
    assert_eq!(second["origin"], "user_correction");
    assert_eq!(
        second["evidence"],
        json!([]),
        "a personal correction must not inherit stale evidence"
    );
    assert_eq!(second["reason"], "本人在电话沟通后补充，尚无新的书面依据");
}

#[test]
fn duplicate_import_and_confirmation_do_not_create_duplicate_knowledge() {
    let directory = TempDir::new().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let project_a = project(&engine, "项目 A");
    let project_b = project(&engine, "项目 B");
    let original = "客户确认上线范围，需保持记录唯一。";
    let first = import_text(&engine, &project_a, "原始纪要", original);
    let repeated = import_text(&engine, &project_a, "重复粘贴", original);
    assert_eq!(repeated["duplicate"], true);
    assert_eq!(first["sourceId"], repeated["sourceId"]);

    let elsewhere = import_text(&engine, &project_b, "另一个项目", original);
    assert_ne!(
        first["sourceId"], elsewhere["sourceId"],
        "deduplication cannot move evidence between projects"
    );
    let proposal = propose(
        &engine,
        &project_a,
        first["sourceId"].as_str().unwrap(),
        "保持上线范围",
    );
    let first_confirmation = confirm(&engine, proposal["id"].as_str().unwrap());
    let second_confirmation = confirm(&engine, proposal["id"].as_str().unwrap());
    assert_eq!(first_confirmation["id"], second_confirmation["id"]);
    let state = execute(&engine, "get_state", json!({}));
    assert_eq!(state["sources"].as_array().unwrap().len(), 2);
    assert_eq!(state["memories"].as_array().unwrap().len(), 1);
    let stored = memory(&engine, first_confirmation["id"].as_str().unwrap());
    assert_eq!(stored["revisions"].as_array().unwrap().len(), 1);
}

#[test]
fn evidence_cannot_cross_project_boundaries_and_stale_edits_are_rejected() {
    let directory = TempDir::new().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let project_a = project(&engine, "甲方交付");
    let project_b = project(&engine, "乙方交付");
    let imported_a = import_text(&engine, &project_a, "甲方纪要", "甲方要求周五上线。");
    let imported_b = import_text(&engine, &project_b, "乙方纪要", "乙方要求下月上线。");
    let source_a = wait_for_source(&engine, imported_a["sourceId"].as_str().unwrap());
    let source_b = wait_for_source(&engine, imported_b["sourceId"].as_str().unwrap());
    let segment_b = first_segment_id(&source_b);
    for (source_id, segment_ids) in [
        (imported_b["sourceId"].clone(), json!([segment_b])),
        (
            imported_a["sourceId"].clone(),
            json!([first_segment_id(&source_b)]),
        ),
    ] {
        expect_error(
            &engine,
            "create_proposal",
            json!({
                "projectId": project_a,
                "sourceId": source_id,
                "segmentIds": segment_ids,
                "kind": "decision",
                "content": "非法引用另一个项目的承诺"
            }),
        );
    }
    let proposal = execute(
        &engine,
        "create_proposal",
        json!({
            "projectId": project_a,
            "sourceId": imported_a["sourceId"],
            "segmentIds": [first_segment_id(&source_a)],
            "kind": "decision",
            "content": "甲方周五上线"
        }),
    );
    let confirmed = confirm(&engine, proposal["id"].as_str().unwrap());
    let memory_id = confirmed["id"].as_str().unwrap();
    let before_invalid = memory(&engine, memory_id);
    expect_error(
        &engine,
        "revise_memory",
        json!({
            "memoryId": memory_id,
            "baseRevision": 1,
            "content": "用乙方纪要覆盖甲方安排",
            "reason": "跨项目证据",
            "segmentIds": [first_segment_id(&source_b)]
        }),
    );
    assert_eq!(memory(&engine, memory_id), before_invalid);
    execute(
        &engine,
        "revise_memory",
        json!({
            "memoryId": memory_id,
            "baseRevision": 1,
            "content": "甲方周五上线，待最终复核",
            "reason": "本人补充"
        }),
    );
    let before_stale = memory(&engine, memory_id);
    expect_error(
        &engine,
        "revise_memory",
        json!({
            "memoryId": memory_id,
            "baseRevision": 1,
            "content": "旧窗口覆盖最新版本",
            "reason": "旧版本修改"
        }),
    );
    assert_eq!(
        memory(&engine, memory_id),
        before_stale,
        "stale edits must be atomic failures"
    );
}

#[test]
fn unknown_source_date_stays_unknown_and_unicode_evidence_is_lossless() {
    let directory = TempDir::new().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let project_id = project(&engine, "国际化交付");
    let original = "李明👩🏽‍💻：明天复核范围；客户说‘不要拆开 emoji 👨‍👩‍👧‍👦’，备注 cafe\u{301}。";
    let imported = import_text(&engine, &project_id, "日期不详的聊天", original);
    let source = wait_for_source(&engine, imported["sourceId"].as_str().unwrap());
    assert!(
        source["source"]["sourceAt"].is_null(),
        "unknown event dates must not use the import date"
    );
    assert!(source["source"]["importedAt"].is_string());
    assert_eq!(source["segments"][0]["text"], original);
    assert!(source["segments"][0]["locator"].is_string());
    let proposal = propose(
        &engine,
        &project_id,
        imported["sourceId"].as_str().unwrap(),
        "明天复核，具体日期待确认",
    );
    let confirmed = confirm(&engine, proposal["id"].as_str().unwrap());
    assert_eq!(
        memory(&engine, confirmed["id"].as_str().unwrap())["revisions"][0]["evidence"][0]["text"],
        original
    );
}

#[test]
fn file_imports_preserve_docx_paragraph_and_table_evidence_and_reject_empty_pdf() {
    let directory = TempDir::new().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let project_id = project(&engine, "文件资料");
    let document_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>范围 &amp; 风险 👩🏽‍💻</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>接口交付：周五</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:sectPr/></w:body></w:document>"#;
    let docx = archive(&[
        ("[Content_Types].xml".into(), br#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#.to_vec()),
        ("_rels/.rels".into(), br#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#.to_vec()),
        ("word/document.xml".into(), document_xml.as_bytes().to_vec()),
    ]);
    let imported = execute(
        &engine,
        "import_file",
        json!({
            "projectId": project_id,
            "filename": "需求纪要.docx",
            "contentBase64": BASE64.encode(&docx)
        }),
    );
    let source = wait_for_source(&engine, imported["sourceId"].as_str().unwrap());
    let segments = source["segments"].as_array().unwrap();
    assert!(segments
        .iter()
        .any(|segment| segment["text"] == "范围 & 风险 👩🏽‍💻"));
    let table_segment = segments
        .iter()
        .find(|segment| segment["text"] == "接口交付：周五")
        .unwrap();
    assert!(table_segment["locator"].as_str().unwrap().contains("表格"));
    let proposal = execute(
        &engine,
        "create_proposal",
        json!({
            "projectId": project_id,
            "sourceId": imported["sourceId"],
            "segmentIds": [table_segment["id"]],
            "kind": "fact",
            "content": "接口交付计划为周五"
        }),
    );
    let confirmed = confirm(&engine, proposal["id"].as_str().unwrap());
    assert_eq!(
        memory(&engine, confirmed["id"].as_str().unwrap())["revisions"][0]["evidence"][0]["text"],
        "接口交付：周五"
    );

    let text_pdf = execute(
        &engine,
        "import_file",
        json!({
            "projectId": project_id,
            "filename": "delivery.pdf",
            "contentBase64": BASE64.encode(one_page_pdf("Delivery confirmed"))
        }),
    );
    let pdf_source = wait_for_source(&engine, text_pdf["sourceId"].as_str().unwrap());
    assert!(pdf_source["segments"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Delivery confirmed"));
    assert!(pdf_source["segments"][0]["locator"]
        .as_str()
        .unwrap()
        .contains('1'));

    let empty_pdf = execute(
        &engine,
        "import_file",
        json!({
            "projectId": project_id,
            "filename": "no-text.pdf",
            "contentBase64": BASE64.encode(one_page_pdf(""))
        }),
    );
    let empty_source = wait_for_terminal_source(&engine, empty_pdf["sourceId"].as_str().unwrap());
    assert_eq!(empty_source["source"]["status"], "failed");
    assert!(empty_source["source"]["error"]
        .as_str()
        .unwrap()
        .contains("OCR"));
    assert_eq!(
        empty_source["segments"],
        json!([]),
        "a failed import cannot leave usable evidence"
    );
}

#[test]
fn backup_restores_into_another_workspace_with_originals_history_and_safety_backup() {
    let source_directory = TempDir::new().unwrap();
    let source_engine = Engine::open(source_directory.path()).unwrap();
    let project_id = project(&source_engine, "待迁移项目");
    let original = "客户邮件：一期保留登录审计。\r\n负责人：李明 👩🏽‍💻\r\n";
    let imported = execute(
        &source_engine,
        "import_file",
        json!({
            "projectId": project_id,
            "filename": "客户邮件.txt",
            "contentBase64": BASE64.encode(original.as_bytes()),
            "sourceAt": "2026-10-10T09:00:00+08:00"
        }),
    );
    let source_id = imported["sourceId"].as_str().unwrap();
    let before_source = wait_for_source(&source_engine, source_id);
    let proposal = propose(&source_engine, &project_id, source_id, "一期保留登录审计");
    let confirmed = confirm(&source_engine, proposal["id"].as_str().unwrap());
    let memory_id = confirmed["id"].as_str().unwrap();
    execute(
        &source_engine,
        "revise_memory",
        json!({
            "memoryId": memory_id,
            "baseRevision": 1,
            "content": "一期保留登录审计，字段待复核",
            "reason": "补充复核步骤",
            "segmentIds": [first_segment_id(&before_source)]
        }),
    );
    let before_memory = memory(&source_engine, memory_id);
    let backup = execute(&source_engine, "create_backup", json!({}));
    let bytes = backup_bytes(source_directory.path(), &backup);
    let exported_entries = entries(&bytes);
    assert!(
        exported_entries
            .iter()
            .any(|(_, bytes)| bytes == original.as_bytes()),
        "backup must preserve exact original file bytes, including line endings"
    );
    assert!(
        !exported_entries
            .iter()
            .any(|(name, _)| name.starts_with("backups/")),
        "backups must not recursively include earlier backups"
    );

    let target_directory = TempDir::new().unwrap();
    let target_engine = Engine::open(target_directory.path()).unwrap();
    let previous_project = project(&target_engine, "恢复前的本地项目");
    let previous_import = import_text(
        &target_engine,
        &previous_project,
        "恢复前资料",
        "这份资料应留在安全备份里。",
    );
    let inspection = execute(&target_engine, "inspect_backup", backup_payload(&bytes));
    assert_eq!(inspection["compatible"], true);
    assert_eq!(inspection["counts"]["memories"], 1);
    let restore = execute(&target_engine, "restore_backup", backup_payload(&bytes));
    let safety_id = restore["safetyBackupId"]
        .as_str()
        .expect("restore must return a retained safety backup id");
    assert_eq!(memory(&target_engine, memory_id), before_memory);
    let after_source = execute(
        &target_engine,
        "get_source",
        json!({ "sourceId": source_id }),
    );
    assert_eq!(after_source["segments"], before_source["segments"]);
    assert_eq!(
        after_source["source"]["sourceAt"],
        before_source["source"]["sourceAt"]
    );
    assert_eq!(
        after_source["source"]["sha256"],
        before_source["source"]["sha256"]
    );
    let state = execute(&target_engine, "get_state", json!({}));
    assert_eq!(state["projects"].as_array().unwrap().len(), 1);
    assert_eq!(state["projects"][0]["id"], project_id);
    let safety = state["backups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|backup| backup["id"] == safety_id)
        .expect("safety backup must remain discoverable after restoring the database");
    let safety_bytes = backup_bytes(target_directory.path(), safety);
    let safety_inspection = execute(
        &target_engine,
        "inspect_backup",
        backup_payload(&safety_bytes),
    );
    assert_eq!(safety_inspection["counts"]["projects"], 1);
    assert_eq!(safety_inspection["counts"]["sources"], 1);
    assert!(entries(&safety_bytes)
        .iter()
        .any(|(_, content)| content == "这份资料应留在安全备份里。".as_bytes()));
    assert_ne!(previous_import["sourceId"], source_id);

    // A fresh snapshot after restoration verifies that originals were copied
    // into the new workspace rather than only referenced in the archive.
    let reexport = execute(&target_engine, "create_backup", json!({}));
    let reexported = backup_bytes(target_directory.path(), &reexport);
    assert!(entries(&reexported)
        .iter()
        .any(|(_, bytes)| bytes == original.as_bytes()));
    drop(target_engine);
    let reopened = Engine::open(target_directory.path()).unwrap();
    assert_eq!(memory(&reopened, memory_id), before_memory);
    let reopened_state = execute(&reopened, "get_state", json!({}));
    assert!(reopened_state["backups"]
        .as_array()
        .unwrap()
        .iter()
        .any(|backup| backup["id"] == safety_id));
}

#[test]
fn invalid_archives_and_checksum_failures_leave_current_state_and_files_unchanged() {
    let directory = TempDir::new().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let project_id = project(&engine, "必须保留的项目");
    let original = "不可被损坏的原始资料。";
    let imported = import_text(&engine, &project_id, "重要资料", original);
    let proposal = propose(
        &engine,
        &project_id,
        imported["sourceId"].as_str().unwrap(),
        "保持当前事实",
    );
    confirm(&engine, proposal["id"].as_str().unwrap());
    let valid = execute(&engine, "create_backup", json!({}));
    let valid_bytes = backup_bytes(directory.path(), &valid);
    let original_entries = entries(&valid_bytes);

    let mut traversal_entries = original_entries.clone();
    traversal_entries.push(("../escaped.txt".into(), b"escape must be rejected".to_vec()));
    let mut absolute_entries = original_entries.clone();
    absolute_entries.push((
        "/absolute-escape.txt".into(),
        b"absolute paths must be rejected".to_vec(),
    ));
    let mut tampered_entries = original_entries.clone();
    let entry = tampered_entries
        .iter_mut()
        .find(|(_, bytes)| bytes == original.as_bytes())
        .expect("text original exists in backup");
    entry.1.extend_from_slice("被篡改".as_bytes());

    let mut self_consistent_tampering = tampered_entries.clone();
    refresh_manifest_checksums(&mut self_consistent_tampering);
    let mut invalid_database = original_entries.clone();
    let database_bytes = &mut invalid_database
        .iter_mut()
        .find(|(name, _)| name == "workspace.sqlite")
        .unwrap()
        .1;
    database_bytes[0] ^= 0xff;
    refresh_manifest_checksums(&mut invalid_database);
    let mut incompatible_schema = original_entries.clone();
    let manifest_entry = incompatible_schema
        .iter_mut()
        .find(|(name, _)| name == "manifest.json")
        .unwrap();
    let mut manifest: Value = serde_json::from_slice(&manifest_entry.1).unwrap();
    manifest["schemaVersion"] = json!(999);
    manifest_entry.1 = serde_json::to_vec(&manifest).unwrap();

    let before = execute(&engine, "get_state", json!({}));
    let mut unconfirmed = backup_payload(&valid_bytes);
    unconfirmed["confirmation"] = json!("restore");
    expect_error(&engine, "restore_backup", unconfirmed);
    assert_eq!(execute(&engine, "get_state", json!({})), before);
    for (label, bytes) in [
        ("invalid ZIP", b"this is not a zip archive".to_vec()),
        (
            "truncated ZIP",
            valid_bytes[..valid_bytes.len() / 2].to_vec(),
        ),
        ("path traversal", archive(&traversal_entries)),
        ("absolute path", archive(&absolute_entries)),
        ("checksum mismatch", archive(&tampered_entries)),
        (
            "original hash does not match database",
            archive(&self_consistent_tampering),
        ),
        (
            "invalid SQLite with self-consistent manifest",
            archive(&invalid_database),
        ),
        ("incompatible schema", archive(&incompatible_schema)),
    ] {
        expect_error(&engine, "inspect_backup", backup_payload(&bytes));
        expect_error(&engine, "restore_backup", backup_payload(&bytes));
        assert_eq!(
            execute(&engine, "get_state", json!({})),
            before,
            "failed {label} restore changed the workspace"
        );
        assert!(!directory.path().join("escaped.txt").exists());
        assert!(!directory
            .path()
            .parent()
            .unwrap()
            .join("escaped.txt")
            .exists());
        assert_eq!(
            backup_bytes(directory.path(), &valid),
            valid_bytes,
            "failed restore changed an existing backup"
        );
    }
    let reexport = execute(&engine, "create_backup", json!({}));
    assert!(entries(&backup_bytes(directory.path(), &reexport))
        .iter()
        .any(|(_, bytes)| bytes == original.as_bytes()));
}

#[test]
fn startup_recovers_queued_and_interrupted_imports_from_persisted_originals() {
    let directory = TempDir::new().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let project_id = project(&engine, "异常退出恢复");
    let queued_text = "排队资料：恢复后仍需保留这段原文 👩🏽‍💻。";
    let running_text = "处理中资料：客户说明需求已经确认。";
    let queued = import_text(&engine, &project_id, "排队原文", queued_text);
    let running = import_text(&engine, &project_id, "处理中原文", running_text);
    drop(engine);

    // Reproduce a crash boundary with complete persisted inputs but no parse
    // output. This is deterministic and does not need a test-only core API.
    let mut database =
        rusqlite::Connection::open(directory.path().join("workspace.sqlite")).unwrap();
    database.busy_timeout(Duration::from_secs(5)).unwrap();
    let transaction = database.transaction().unwrap();
    for (imported, status) in [(&queued, "queued"), (&running, "running")] {
        transaction.execute(
            "UPDATE jobs SET status=?1,stage='interrupted acceptance fixture',error=NULL,recovered=0 WHERE id=?2",
            rusqlite::params![status, imported["jobId"].as_str().unwrap()],
        ).unwrap();
        transaction
            .execute(
                "UPDATE sources SET status='processing',segment_count=0,error=NULL WHERE id=?1",
                [imported["sourceId"].as_str().unwrap()],
            )
            .unwrap();
        transaction
            .execute(
                "DELETE FROM segments WHERE source_id=?1",
                [imported["sourceId"].as_str().unwrap()],
            )
            .unwrap();
    }
    transaction.commit().unwrap();
    drop(database);

    let recovered = Engine::open(directory.path()).unwrap();
    let queued_source = wait_for_source(&recovered, queued["sourceId"].as_str().unwrap());
    let running_source = wait_for_source(&recovered, running["sourceId"].as_str().unwrap());
    assert_eq!(queued_source["segments"][0]["text"], queued_text);
    assert_eq!(running_source["segments"][0]["text"], running_text);
    assert_eq!(queued_source["source"]["sourceAt"], Value::Null);
    let state = execute(&recovered, "get_state", json!({}));
    assert_eq!(state["workspace"]["recoveredJobs"], 2);
    assert_eq!(state["sources"].as_array().unwrap().len(), 2);
    assert_eq!(state["jobs"].as_array().unwrap().len(), 2);
    for job in state["jobs"].as_array().unwrap() {
        assert_eq!(job["status"], "succeeded");
        assert_eq!(job["recovered"], true);
    }
    drop(recovered);
    let reopened = Engine::open(directory.path()).unwrap();
    let state = execute(&reopened, "get_state", json!({}));
    assert_eq!(state["workspace"]["recoveredJobs"], 0);
    assert_eq!(
        wait_for_source(&reopened, queued["sourceId"].as_str().unwrap())["segments"],
        queued_source["segments"]
    );
    assert_eq!(
        wait_for_source(&reopened, running["sourceId"].as_str().unwrap())["segments"],
        running_source["segments"]
    );
}

#[test]
fn structurally_valid_backups_with_broken_memory_invariants_are_rejected_atomically() {
    let directory = TempDir::new().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let project_id = project(&engine, "记忆一致性");
    let imported = import_text(&engine, &project_id, "决定来源", "客户确认一期范围。");
    let confirmed_proposal = propose(
        &engine,
        &project_id,
        imported["sourceId"].as_str().unwrap(),
        "客户已确认一期范围",
    );
    confirm(&engine, confirmed_proposal["id"].as_str().unwrap());
    propose(
        &engine,
        &project_id,
        imported["sourceId"].as_str().unwrap(),
        "尚未确认的候选",
    );
    let backup = execute(&engine, "create_backup", json!({}));
    let original_entries = entries(&backup_bytes(directory.path(), &backup));
    let before = execute(&engine, "get_state", json!({}));
    for (label, sql) in [
        ("candidate without evidence", "DELETE FROM proposal_evidence WHERE proposal_id IN (SELECT id FROM proposals WHERE status='pending');"),
        ("confirmation without evidence", "DELETE FROM revision_evidence WHERE revision_id IN (SELECT id FROM revisions WHERE origin='confirmation');"),
        ("current memory disagrees with history", "UPDATE memories SET content='未记录在修订历史里的内容';"),
        ("current revision is missing", "UPDATE memories SET revision=99;"),
        ("source metadata has incompatible storage type", "UPDATE sources SET title=x'00ff';"),
        ("revision metadata has incompatible storage type", "UPDATE revisions SET reason=x'00ff';"),
        ("unsafe backup registry path", "INSERT INTO backups VALUES ('malicious-path','../../private.txt','2026-10-18T00:00:00Z',1,'invalid','{}');"),
    ] {
        let malformed = alter_backup_database(&original_entries, sql);
        expect_error(&engine, "inspect_backup", backup_payload(&malformed));
        expect_error(&engine, "restore_backup", backup_payload(&malformed));
        assert_eq!(execute(&engine, "get_state", json!({})), before, "rejected {label} changed current state");
    }
}

#[test]
fn restore_journal_rolls_back_interrupted_originals_swap_and_database_replacement() {
    // A second genuine workspace supplies the post-swap state. The fixtures
    // model process termination at two filesystem boundaries, never a mocked
    // response from the recovery implementation.
    let replacement_directory = TempDir::new().unwrap();
    let replacement_engine = Engine::open(replacement_directory.path()).unwrap();
    let replacement_project = project(&replacement_engine, "尚未提交的恢复内容");
    import_text(
        &replacement_engine,
        &replacement_project,
        "替换资料",
        "恢复尚未完成，不应成为最终状态。",
    );
    let replacement_backup = execute(&replacement_engine, "create_backup", json!({}));
    let replacement_entries = entries(&backup_bytes(
        replacement_directory.path(),
        &replacement_backup,
    ));
    drop(replacement_engine);

    for database_was_replaced in [false, true] {
        let directory = TempDir::new().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        let project_id = project(&engine, "恢复前已确认的项目");
        let original = "原项目的决定和证据必须一起保留 👩🏽‍💻。";
        let imported = import_text(&engine, &project_id, "原始确认", original);
        let proposal = propose(
            &engine,
            &project_id,
            imported["sourceId"].as_str().unwrap(),
            "原项目范围已确认",
        );
        let confirmed = confirm(&engine, proposal["id"].as_str().unwrap());
        let memory_id = confirmed["id"].as_str().unwrap().to_owned();
        let expected_memory = memory(&engine, &memory_id);
        let safety_backup = execute(&engine, "create_backup", json!({}));
        drop(engine);

        fs::write(
            directory.path().join("restore-journal.json"),
            serde_json::to_vec(&json!({
                "formatVersion": 1,
                "safetyBackup": safety_backup
            }))
            .unwrap(),
        )
        .unwrap();
        let interrupted_stage = directory.path().join("staging").join("interrupted-restore");
        fs::create_dir_all(&interrupted_stage).unwrap();
        fs::rename(
            directory.path().join("originals"),
            interrupted_stage.join("previous-originals"),
        )
        .unwrap();
        if database_was_replaced {
            fs::create_dir_all(directory.path().join("originals")).unwrap();
            for (name, bytes) in &replacement_entries {
                if name == "workspace.sqlite" || name.starts_with("originals/") {
                    fs::write(directory.path().join(name), bytes).unwrap();
                }
            }
        }

        let recovered = Engine::open(directory.path()).unwrap();
        assert_eq!(
            memory(&recovered, &memory_id),
            expected_memory,
            "recovery must roll back the database and original files together"
        );
        let state = execute(&recovered, "get_state", json!({}));
        assert_eq!(state["projects"].as_array().unwrap().len(), 1);
        assert_eq!(state["projects"][0]["id"], project_id);
        assert!(
            state["backups"]
                .as_array()
                .unwrap()
                .iter()
                .any(|backup| backup["id"] == safety_backup["id"]),
            "crash recovery must retain its safety snapshot"
        );
        assert!(!directory.path().join("restore-journal.json").exists());
        let reexport = execute(&recovered, "create_backup", json!({}));
        assert!(entries(&backup_bytes(directory.path(), &reexport))
            .iter()
            .any(|(_, bytes)| bytes == original.as_bytes()));
        drop(recovered);
        let second_open = Engine::open(directory.path()).unwrap();
        assert_eq!(
            memory(&second_open, &memory_id),
            expected_memory,
            "recovery must commit exactly once across reopen"
        );
    }
}
