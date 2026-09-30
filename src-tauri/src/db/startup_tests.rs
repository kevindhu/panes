use super::*;

fn fixture() -> Database {
    let db = Database::open(
        std::env::temp_dir().join(format!("panes-startup-{}.db", uuid::Uuid::new_v4())),
    )
    .unwrap();
    db.connect().unwrap().execute_batch(
        "INSERT INTO workspaces(id,name,root_path) VALUES('w','Workspace','/workspace');
         INSERT INTO threads(id,workspace_id,engine_id,model_id) VALUES('t','w','codex','model');
         INSERT INTO messages(id,thread_id,role,content,blocks_json,status,turn_engine_id)
           VALUES('m','t','assistant','searchable sentinel','[{\"type\":\"text\",\"content\":\"retained\"}]','completed','legacy-turn');"
    ).unwrap();
    db
}

#[test]
fn startup_migration_is_atomic_retryable_and_not_replayed_on_reopen() {
    let db = fixture();
    let conn = db.connect().unwrap();
    conn.execute_batch(
        "PRAGMA user_version = 0;
         DROP INDEX idx_messages_runtime;
         CREATE TRIGGER fail_backfill BEFORE UPDATE OF native_turn_id ON messages
           BEGIN SELECT RAISE(ABORT, 'simulated interrupted migration'); END;",
    )
    .unwrap();
    assert!(db.run_migrations().is_err());
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'idx_messages_runtime'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row(
            "SELECT native_turn_id FROM messages WHERE id='m'",
            [],
            |row| row.get::<_, Option<String>>(0)
        )
        .unwrap(),
        None
    );

    conn.execute_batch("DROP TRIGGER fail_backfill").unwrap();
    db.run_migrations().unwrap();
    let message: (String, String, String) = conn
        .query_row(
            "SELECT native_turn_id, content, blocks_json FROM messages WHERE id='m'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        message,
        (
            "legacy-turn".into(),
            "searchable sentinel".into(),
            "[{\"type\":\"text\",\"content\":\"retained\"}]".into()
        )
    );
    let reopened = Database::open(db.path.clone()).unwrap();
    assert_eq!(
        reopened
            .connect()
            .unwrap()
            .query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
}

#[test]
fn startup_metadata_updates_preserve_search_without_reindexing_bodies() {
    let db = fixture();
    let conn = db.connect().unwrap();
    let changes = || {
        conn.query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
            .unwrap()
    };
    let matches = |term: &str| {
        conn.query_row(
            "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?1",
            [term],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
    };
    let before = changes();
    conn.execute("UPDATE messages SET status='interrupted', native_turn_id='native', blocks_json='[]' WHERE id='m'", []).unwrap();
    assert_eq!(
        changes() - before,
        1,
        "metadata updates must only write the message row"
    );
    assert_eq!(matches("sentinel"), 1);
    let before = changes();
    conn.execute("UPDATE messages SET content=content WHERE id='m'", [])
        .unwrap();
    assert_eq!(changes() - before, 1);
    conn.execute(
        "UPDATE messages SET content='replacement token' WHERE id='m'",
        [],
    )
    .unwrap();
    assert_eq!(matches("sentinel"), 0);
    assert_eq!(matches("replacement"), 1);
    conn.execute("DELETE FROM messages WHERE id='m'", [])
        .unwrap();
    assert_eq!(matches("replacement"), 0);
}

#[test]
fn startup_rejects_newer_schemas_without_modifying_them() {
    let db = fixture();
    let conn = db.connect().unwrap();
    conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();
    assert!(Database::open(db.path.clone()).is_err());
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        SCHEMA_VERSION + 1
    );
}
