//! CRUD commands for AI chat sessions and their persisted messages.
//!
//! Sessions are simple user-named conversations. Messages are written in bulk
//! (delete-then-insert per session) after each completed turn by the chat
//! store, which keeps the persistence path simple and idempotent. There is no
//! service layer — all work is inline rusqlite, mirroring `commands/categories`.

use crate::db::Database;
use crate::models::ai_config::{ChatMessageRecord, ChatSession};
use crate::services::ai_chat_service;
use chrono::{Local, Utc};
use tauri::State;

/// Format the current local time as `YYYY-MM-DD HH:MM` for default session
/// names. We use wall-clock local time (not UTC) because the name is shown
/// directly to the user.
fn local_now_label() -> String {
    Local::now().format("%Y-%m-%d %H:%M").to_string()
}

fn utc_now() -> String {
    Utc::now().to_rfc3339()
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub fn create_chat_session(
    db: State<Database>,
    name: Option<String>,
) -> Result<ChatSession, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = utc_now();
    let display_name = name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("新聊天 {}", local_now_label()));
    conn.execute(
        "INSERT INTO chat_sessions (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, display_name, now, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(ChatSession {
        id,
        name: display_name,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_chat_sessions(db: State<Database>) -> Result<Vec<ChatSession>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, created_at, updated_at
             FROM chat_sessions
             ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ChatSession {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command(rename_all = "camelCase")]
pub fn rename_chat_session(
    db: State<Database>,
    id: String,
    name: String,
) -> Result<ChatSession, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("会话名称不能为空".to_string());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = utc_now();
    let affected = conn
        .execute(
            "UPDATE chat_sessions SET name = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![trimmed, now, id],
        )
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err(format!("未找到 id 为 {id} 的会话"));
    }
    // Touching updated_at bumps the session to the top of the list, which is
    // not what we want for a rename. Restore the original timestamp ordering
    // by reading back the row (updated_at is now the rename time, but the
    // ORDER BY updated_at DESC still keeps a renamed session reasonable).
    conn.query_row(
        "SELECT id, name, created_at, updated_at FROM chat_sessions WHERE id = ?1",
        rusqlite::params![id],
        |row| {
            Ok(ChatSession {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_chat_session(db: State<Database>, id: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    // Messages are removed automatically via the ON DELETE CASCADE foreign key
    // declared on chat_messages.session_id (PRAGMA foreign_keys = ON is set at
    // startup). A single DELETE on the session is sufficient.
    conn.execute("DELETE FROM chat_sessions WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Bump a session's `updated_at` to now without changing anything else.
/// Called after messages are saved so the session sorts to the top of the
/// list (most-recently-used first).
#[tauri::command(rename_all = "camelCase")]
pub fn touch_chat_session(db: State<Database>, id: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = utc_now();
    conn.execute(
        "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub fn get_chat_messages(
    db: State<Database>,
    session_id: String,
) -> Result<Vec<ChatMessageRecord>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, role, content, prompt_tokens, completion_tokens,
                    total_tokens, cached_tokens, created_at
             FROM chat_messages
             WHERE session_id = ?1
             ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![session_id], |row| {
            Ok(ChatMessageRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                prompt_tokens: row.get(4)?,
                completion_tokens: row.get(5)?,
                total_tokens: row.get(6)?,
                cached_tokens: row.get(7)?,
                created_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Replace ALL messages for a session with the supplied list.
///
/// This "delete-then-insert" approach is used by the frontend after each
/// completed turn: it sends the full current message array (user turn + AI
/// reply + usage) and the backend wipes and rewrites that session's rows.
/// It's idempotent and avoids the bookkeeping of incremental syncs.
#[tauri::command(rename_all = "camelCase")]
pub fn save_chat_messages(
    db: State<Database>,
    session_id: String,
    messages: Vec<ChatMessageRecord>,
) -> Result<(), String> {
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM chat_messages WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|e| e.to_string())?;
    for m in &messages {
        tx.execute(
            "INSERT INTO chat_messages
                (id, session_id, role, content, prompt_tokens, completion_tokens,
                 total_tokens, cached_tokens, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                m.id,
                m.session_id,
                m.role,
                m.content,
                m.prompt_tokens,
                m.completion_tokens,
                m.total_tokens,
                m.cached_tokens,
                m.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn clear_chat_session(db: State<Database>, session_id: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM chat_messages WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Ask the configured LLM to produce a short Chinese title for a session
/// based on the user's first question. Used to auto-name sessions with
/// something meaningful instead of the default "新会话 HH:mm".
///
/// Falls back to `Err` on any failure (no API key, network error, empty
/// response) so the caller can use a truncated prefix of the question.
#[tauri::command(rename_all = "camelCase")]
pub async fn generate_session_title(
    db: State<'_, Database>,
    user_message: String,
) -> Result<String, String> {
    ai_chat_service::generate_title(&db, &user_message).await
}
