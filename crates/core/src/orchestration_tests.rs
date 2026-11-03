use super::*;
use crate::{db::Database, Request};

fn at(value: &str) -> DateTime<FixedOffset> {
    DateTime::parse_from_rfc3339(value).unwrap()
}
fn call(db: &mut Database, command: &str, payload: Value) -> Value {
    db.execute(Request {
        command: command.into(),
        payload,
    })
    .unwrap()
}
fn setup() -> (tempfile::TempDir, Database, Value, Value) {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Database::open(dir.path().to_owned()).unwrap();
    let project = call(&mut db, "create_project", json!({"name":"项目甲"}));
    let task = call(
        &mut db,
        "create_task",
        json!({"projectId":project["id"],"title":"接口交付","description":"有验收标准","category":"follow_up","assignee":"小周","priority":"high","status":"in_progress","progress":30,"dueDate":"2026-10-17","plannedDate":null,"workDate":"2026-10-16","clientRequestId":id()}),
    );
    (dir, db, project, task)
}
fn scan(db: &mut Database, time: &str) {
    let tx = db.conn.transaction().unwrap();
    tick_at(&tx, &at(time)).unwrap();
    tx.commit().unwrap();
}
fn work(db: &Database) -> Value {
    center(&db.conn, &json!({})).unwrap()["works"][0].clone()
}
fn choose(db: &mut Database, p: &Value, time: &str) -> Result<Value> {
    let tx = db.conn.transaction()?;
    let r = decide(&tx, p, &at(time))?;
    tx.commit()?;
    Ok(r)
}

#[test]
fn transactional_event_deduplicates_and_rolls_back_with_business_write() {
    let (_dir, mut db, _project, t) = setup();
    let count = |c: &Connection| {
        c.query_row(
            "SELECT count(*) FROM assistant_events WHERE status='pending'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
    };
    assert_eq!(count(&db.conn), 1);
    {
        let tx = db.conn.transaction().unwrap();
        tx.execute(
            "UPDATE tasks SET title='暂存修改',version=version+1 WHERE id=?",
            [t["id"].as_str()],
        )
        .unwrap();
        assert_eq!(count(&tx), 1);
    }
    assert_eq!(
        tasks::task(&db.conn, t["id"].as_str().unwrap()).unwrap()["title"],
        "接口交付"
    );
    scan(&mut db, "2026-10-19T09:00:00+08:00");
    let first = work(&db);
    scan(&mut db, "2026-10-19T09:01:00+08:00");
    assert_eq!(work(&db), first);
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM assistant_work_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn outer_replace_and_upsert_keep_the_original_pending_event() {
    let (_dir, db, project, task) = setup();
    let pending = |conn: &Connection| {
        conn.query_row("SELECT id FROM assistant_events WHERE entity_kind='task' AND entity_id=? AND status='pending'",[task["id"].as_str()],|r|r.get::<_,i64>(0)).unwrap()
    };
    let first = pending(&db.conn);
    for version in 1..=2 {
        db.conn.execute("INSERT OR REPLACE INTO task_follow_up_state(task_id,project_id,next_follow_up_date,snoozed_until,version,updated_at) VALUES(?,?,'2026-10-20',NULL,?,?)",params![task["id"].as_str(),project["id"].as_str(),version,now()]).unwrap();
        assert_eq!(
            pending(&db.conn),
            first,
            "REPLACE must not replace the outbox row"
        );
    }
    for status in ["active", "on_hold", "active"] {
        db.conn.execute("INSERT INTO project_profiles(project_id,goal,status,target_date,version,updated_at) VALUES(?,'核对交付',?,NULL,1,?) ON CONFLICT(project_id) DO UPDATE SET status=excluded.status,version=project_profiles.version+1,updated_at=excluded.updated_at",params![project["id"].as_str(),status,now()]).unwrap();
        assert_eq!(
            pending(&db.conn),
            first,
            "UPSERT must not override queue deduplication"
        );
    }
    db.conn.execute("INSERT INTO task_follow_up_state(task_id,project_id,next_follow_up_date,snoozed_until,version,updated_at) VALUES(?,?,'2026-10-21',NULL,3,?) ON CONFLICT(task_id) DO UPDATE SET next_follow_up_date=excluded.next_follow_up_date,version=excluded.version",params![task["id"].as_str(),project["id"].as_str(),now()]).unwrap();
    assert_eq!(pending(&db.conn), first);
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM assistant_events WHERE status='pending'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    validate_expected_triggers(&db.conn).unwrap();
}

#[test]
fn explicit_decision_writes_followup_once_and_survives_restart() {
    let (dir, mut db, _project, t) = setup();
    scan(&mut db, "2026-10-19T09:00:00+08:00");
    let w = work(&db);
    let p = json!({"workId":w["id"],"baseVersion":w["version"],"decisionId":"one-decision","choice":"record_follow_up","note":"已确认明天提供验收材料","reviewAt":"2026-10-20T09:00:00+08:00"});
    let first = choose(&mut db, &p, "2026-10-19T09:05:00+08:00").unwrap();
    assert_eq!(first["status"], "watching");
    assert_eq!(
        tasks::task(&db.conn, t["id"].as_str().unwrap()).unwrap()["status"],
        "in_progress"
    );
    drop(db);
    let mut db = Database::open(dir.path().to_owned()).unwrap();
    assert_eq!(
        choose(&mut db, &p, "2026-10-19T09:06:00+08:00").unwrap(),
        first
    );
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM task_follow_ups", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let mut wrong = p.clone();
    wrong["note"] = json!("改用同一ID执行另一件事");
    assert_eq!(
        choose(&mut db, &wrong, "2026-10-19T09:07:00+08:00")
            .unwrap_err()
            .code,
        "IDEMPOTENCY_CONFLICT"
    );
    scan(&mut db, "2026-10-19T09:08:00+08:00");
    assert_eq!(
        get_work(&db.conn, w["id"].as_str().unwrap()).unwrap()["status"],
        "watching"
    );
    scan(&mut db, "2026-10-20T09:01:00+08:00");
    assert_eq!(
        get_work(&db.conn, w["id"].as_str().unwrap()).unwrap()["status"],
        "ready"
    );
}

#[test]
fn stale_decision_is_rejected_even_before_event_consumption() {
    let (_dir, mut db, _project, t) = setup();
    scan(&mut db, "2026-10-19T09:00:00+08:00");
    let w = work(&db);
    db.conn
        .execute(
            "UPDATE tasks SET assignee='小林',version=version+1 WHERE id=?",
            [t["id"].as_str()],
        )
        .unwrap();
    let p = json!({"workId":w["id"],"baseVersion":w["version"],"decisionId":id(),"choice":"adopt_date","note":"调整日期","reviewAt":"2026-10-20T09:00:00+08:00","proposedDate":"2026-10-22"});
    assert_eq!(
        choose(&mut db, &p, "2026-10-19T09:01:00+08:00")
            .unwrap_err()
            .code,
        "VERSION_CONFLICT"
    );
    assert_eq!(
        tasks::task(&db.conn, t["id"].as_str().unwrap()).unwrap()["dueDate"],
        "2026-10-17"
    );
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM assistant_decisions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn date_change_and_followup_rollback_together_on_invalid_work_date() {
    let (_dir, mut db, _project, t) = setup();
    db.conn
        .execute(
            "UPDATE task_events SET work_date='2026-10-21' WHERE task_id=?",
            [t["id"].as_str()],
        )
        .unwrap();
    scan(&mut db, "2026-10-19T09:00:00+08:00");
    let w = work(&db);
    let p = json!({"workId":w["id"],"baseVersion":w["version"],"decisionId":id(),"choice":"adopt_date","note":"调整日期","reviewAt":"2026-10-20T09:00:00+08:00","proposedDate":"2026-10-22"});
    assert!(choose(&mut db, &p, "2026-10-19T09:01:00+08:00").is_err());
    assert_eq!(
        tasks::task(&db.conn, t["id"].as_str().unwrap()).unwrap()["dueDate"],
        "2026-10-17"
    );
    assert_eq!(work(&db)["version"], w["version"]);
}

#[test]
fn date_choice_applies_only_requested_deadline_and_records_provenance() {
    let (_dir, mut db, _project, t) = setup();
    scan(&mut db, "2026-10-19T09:00:00+08:00");
    let w = work(&db);
    let p = json!({"workId":w["id"],"baseVersion":w["version"],"decisionId":id(),"choice":"adopt_date","note":"责任人确认新的截止日期","reviewAt":"2026-10-21T09:00:00+08:00","proposedDate":"2026-10-22"});
    choose(&mut db, &p, "2026-10-19T09:01:00+08:00").unwrap();
    let after = tasks::task(&db.conn, t["id"].as_str().unwrap()).unwrap();
    assert_eq!(after["dueDate"], "2026-10-22");
    assert_eq!(after["status"], t["status"]);
    assert_eq!(after["assignee"], t["assignee"]);
    scan(&mut db, "2026-10-19T09:02:00+08:00");
    assert_eq!(
        get_work(&db.conn, w["id"].as_str().unwrap()).unwrap()["status"],
        "watching"
    );
    scan(&mut db, "2026-10-21T09:01:00+08:00");
    assert_eq!(
        get_work(&db.conn, w["id"].as_str().unwrap()).unwrap()["status"],
        "ready"
    );
    db.conn
        .execute(
            "UPDATE tasks SET status='done',progress=100,version=version+1 WHERE id=?",
            [t["id"].as_str()],
        )
        .unwrap();
    scan(&mut db, "2026-10-21T09:02:00+08:00");
    assert_eq!(
        get_work(&db.conn, w["id"].as_str().unwrap()).unwrap()["status"],
        "resolved"
    );
    validate_backup(&db.conn).unwrap();
}

#[test]
fn paused_and_cancelled_work_remain_quiet_until_explicit_resume() {
    let (_dir, mut db, _project, t) = setup();
    scan(&mut db, "2026-10-19T09:00:00+08:00");
    let w = work(&db);
    let paused = dispatch(
        &mut db.conn,
        "pause_assistant_work",
        &json!({"workId":w["id"],"baseVersion":w["version"],"paused":true}),
    )
    .unwrap();
    db.conn
        .execute(
            "UPDATE tasks SET progress=40,version=version+1 WHERE id=?",
            [t["id"].as_str()],
        )
        .unwrap();
    scan(&mut db, "2026-10-19T09:03:00+08:00");
    assert_eq!(work(&db)["status"], "paused");
    let resumed = dispatch(
        &mut db.conn,
        "pause_assistant_work",
        &json!({"workId":w["id"],"baseVersion":paused["version"],"paused":false}),
    )
    .unwrap();
    assert_eq!(resumed["status"], "ready");
    let p = json!({"workId":w["id"],"baseVersion":resumed["version"],"decisionId":id(),"choice":"dismiss"});
    choose(&mut db, &p, "2026-10-19T09:04:00+08:00").unwrap();
    scan(&mut db, "2026-10-20T09:00:00+08:00");
    assert_eq!(work(&db)["status"], "cancelled");
}

#[test]
fn restore_pauses_processing_and_reads_have_no_side_effects() {
    let (_dir, mut db, _project, _task) = setup();
    pause_after_restore(&db.conn).unwrap();
    assert_eq!(center(&db.conn, &json!({})).unwrap()["works"], json!([]));
    scan(&mut db, "2026-10-19T09:00:00+08:00");
    assert_eq!(center(&db.conn, &json!({})).unwrap()["works"], json!([]));
    let s = settings(&db.conn).unwrap();
    dispatch(
        &mut db.conn,
        "save_assistant_work_settings",
        &json!({"enabled":true,"baseVersion":s["version"]}),
    )
    .unwrap();
    scan(&mut db, "2026-10-19T09:01:00+08:00");
    assert_eq!(work(&db)["status"], "ready");
}

#[test]
fn project_isolation_and_archive_prevent_old_decisions() {
    let (_dir, mut db, project, _task) = setup();
    let other = call(&mut db, "create_project", json!({"name":"项目乙"}));
    scan(&mut db, "2026-10-19T09:00:00+08:00");
    let w = work(&db);
    assert_eq!(
        center(&db.conn, &json!({"projectId":other["id"]})).unwrap()["counts"]["total"],
        0
    );
    db.conn
        .execute(
            "INSERT INTO workspace_lifecycle VALUES('project',?,1,NULL,'已归档',1,?)",
            params![project["id"].as_str(), now()],
        )
        .unwrap();
    let p =
        json!({"workId":w["id"],"baseVersion":w["version"],"decisionId":id(),"choice":"dismiss"});
    assert_eq!(
        choose(&mut db, &p, "2026-10-19T09:01:00+08:00")
            .unwrap_err()
            .code,
        "VERSION_CONFLICT"
    );
    scan(&mut db, "2026-10-19T09:02:00+08:00");
    assert_eq!(work(&db)["status"], "resolved");
}

#[test]
fn same_day_review_keeps_exact_time_without_creating_duplicate_work() {
    let (_dir, mut db, _project, _task) = setup();
    scan(&mut db, "2026-10-19T09:00:00+08:00");
    let w = work(&db);
    let p = json!({"workId":w["id"],"baseVersion":w["version"],"decisionId":id(),"choice":"adopt_date","note":"已确认下次交付与复查时间","reviewAt":"2026-10-19T15:00:00+08:00","proposedDate":"2026-10-22"});
    choose(&mut db, &p, "2026-10-19T09:01:00+08:00").unwrap();
    scan(&mut db, "2026-10-19T09:02:00+08:00");
    let c = center(&db.conn, &json!({})).unwrap();
    assert_eq!(c["counts"]["total"], 1);
    assert_eq!(c["works"][0]["status"], "watching");
    scan(&mut db, "2026-10-19T15:01:00+08:00");
    assert_eq!(work(&db)["status"], "ready");
}

#[test]
fn each_tick_is_bounded_and_remaining_events_survive_restart() {
    let (dir, mut db, project, _task) = setup();
    for n in 0..70 {
        let p = json!({"projectId":project["id"],"title":format!("任务{n}"),"description":"","category":"action","assignee":null,"priority":"low","status":"todo","progress":0,"dueDate":"2026-10-17","plannedDate":null,"workDate":"2026-10-16"});
        let tx = db.conn.transaction().unwrap();
        tasks::insert_task(&tx, &p, "user", None, &[], "").unwrap();
        tx.commit().unwrap();
    }
    scan(&mut db, "2026-10-19T09:00:00+08:00");
    assert_eq!(center(&db.conn, &json!({})).unwrap()["pendingEvents"], 7);
    drop(db);
    let mut db = Database::open(dir.path().to_owned()).unwrap();
    scan(&mut db, "2026-10-19T09:01:00+08:00");
    assert_eq!(center(&db.conn, &json!({})).unwrap()["pendingEvents"], 0);
    assert_eq!(center(&db.conn, &json!({})).unwrap()["counts"]["total"], 71);
}

#[test]
fn review_navigation_does_not_resolve_conflict_but_actual_review_does() {
    let (_dir, mut db, project, _task) = setup();
    db.conn.execute("INSERT INTO sources(id,project_id,title,kind,original_filename,imported_at,sha256,status,segment_count,original_path) VALUES('source',?,'变更纪要','text','note.txt',?,'fixture-hash','ready',1,'originals/note.txt')",params![project["id"].as_str(),now()]).unwrap();
    db.conn.execute("INSERT INTO proposals(id,project_id,source_id,kind,content,status,created_at) VALUES('proposal',?,'source','fact','交付范围需要核对','pending',?)",params![project["id"].as_str(),now()]).unwrap();
    db.conn.execute("INSERT INTO memory_reviews(id,proposal_id,disposition,reason,status,created_at,updated_at) VALUES('review','proposal','uncertain','缺少拍板依据','pending',?1,?1)",[now()]).unwrap();
    scan(&mut db, "2026-10-19T09:00:00+08:00");
    let list = center(&db.conn, &json!({})).unwrap();
    let w = list["works"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["kind"] == "memory_conflict")
        .unwrap()
        .clone();
    let p = json!({"workId":w["id"],"baseVersion":w["version"],"decisionId":id(),"choice":"open_review"});
    choose(&mut db, &p, "2026-10-19T09:01:00+08:00").unwrap();
    assert_eq!(
        db.conn
            .query_row(
                "SELECT status FROM memory_reviews WHERE id='review'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "pending"
    );
    assert_eq!(
        get_work(&db.conn, w["id"].as_str().unwrap()).unwrap()["status"],
        "watching"
    );
    db.conn
        .execute(
            "UPDATE memory_reviews SET status='resolved' WHERE id='review'",
            [],
        )
        .unwrap();
    scan(&mut db, "2026-10-19T09:02:00+08:00");
    assert_eq!(
        get_work(&db.conn, w["id"].as_str().unwrap()).unwrap()["status"],
        "resolved"
    );
    db.conn
        .execute(
            "UPDATE memory_reviews SET status='pending' WHERE id='review'",
            [],
        )
        .unwrap();
    scan(&mut db, "2026-10-19T09:03:00+08:00");
    assert_eq!(
        get_work(&db.conn, w["id"].as_str().unwrap()).unwrap()["status"],
        "ready"
    );
    db.conn
        .execute("DELETE FROM memory_reviews WHERE id='review'", [])
        .unwrap();
    scan(&mut db, "2026-10-19T09:04:00+08:00");
    assert_eq!(
        get_work(&db.conn, w["id"].as_str().unwrap()).unwrap()["status"],
        "resolved"
    );
}

#[test]
fn backup_accepts_only_complete_trusted_trigger_definitions() {
    let (_dir, db, _project, _task) = setup();
    validate_expected_triggers(&db.conn).unwrap();
    let original: String = db
        .conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='assistant_task_insert'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    db.conn.execute_batch("DROP TRIGGER assistant_task_insert; CREATE TRIGGER assistant_task_insert AFTER INSERT ON tasks BEGIN DELETE FROM assistant_work; END;").unwrap();
    assert_eq!(
        validate_expected_triggers(&db.conn).unwrap_err().code,
        "INVALID_BACKUP"
    );
    db.conn
        .execute_batch("DROP TRIGGER assistant_task_insert;")
        .unwrap();
    assert_eq!(
        validate_expected_triggers(&db.conn).unwrap_err().code,
        "INVALID_BACKUP"
    );
    db.conn.execute_batch(&original).unwrap();
    validate_expected_triggers(&db.conn).unwrap();
    db.conn.execute_batch("CREATE TRIGGER unrelated_trigger AFTER INSERT ON projects BEGIN DELETE FROM assistant_work; END;").unwrap();
    assert_eq!(
        validate_expected_triggers(&db.conn).unwrap_err().code,
        "INVALID_BACKUP"
    );
    db.conn
        .execute_batch(
            "DROP TRIGGER unrelated_trigger; CREATE VIEW unexpected_view AS SELECT * FROM tasks;",
        )
        .unwrap();
    assert_eq!(
        validate_expected_triggers(&db.conn).unwrap_err().code,
        "INVALID_BACKUP"
    );
}
