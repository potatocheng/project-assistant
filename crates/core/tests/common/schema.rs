//! Remove current-only objects when constructing a historical-schema fixture.
pub fn remove_schema_14(conn: &rusqlite::Connection) {
    let names = {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'assistant_*'",
            )
            .unwrap();
        let names = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        names
    };
    for name in names {
        conn.execute_batch(&format!("DROP TRIGGER \"{}\";", name.replace('"', "\"\"")))
            .unwrap();
    }
    conn.execute_batch("DROP TABLE assistance_requests;DROP TABLE assistance_runs;DROP TABLE assistant_work_history;DROP TABLE assistant_decisions;DROP TABLE assistant_work_runs;DROP TABLE assistant_work;DROP TABLE assistant_events;DROP TABLE assistant_work_settings;").unwrap();
}
