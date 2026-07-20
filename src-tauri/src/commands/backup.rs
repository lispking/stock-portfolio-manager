use crate::db::Database;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Manager, State};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct BackupConfig {
    pub directory: Option<String>,
    pub auto_backup: bool,
    pub last_backup_mtime: Option<u64>,
    pub last_backup_size: Option<u64>,
    pub last_backup_time: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BackupResult {
    pub success: bool,
    pub path: Option<String>,
    pub message: Option<String>,
}

pub(crate) fn config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("failed to get app data dir")
        .join("backup_config.json")
}

fn load_config(app: &tauri::AppHandle) -> BackupConfig {
    let path = config_path(app);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(app: &tauri::AppHandle, config: &BackupConfig) -> Result<(), String> {
    let path = config_path(app);
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// Get file mtime as seconds since epoch, or None if unavailable.
fn file_mtime_secs(path: &str) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(dur.as_secs())
}

fn file_size(path: &str) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

/// Check if DB has changed since last backup.
fn db_changed(db_path: &str, config: &BackupConfig) -> bool {
    let mtime = file_mtime_secs(db_path);
    let size = file_size(db_path);
    mtime != config.last_backup_mtime || size != config.last_backup_size
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_backup_config(app: tauri::AppHandle) -> BackupConfig {
    load_config(&app)
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_backup_config(app: tauri::AppHandle, config: BackupConfig) -> Result<(), String> {
    save_config(&app, &config)
}

#[tauri::command(rename_all = "camelCase")]
pub fn backup_database_now(
    app: tauri::AppHandle,
    db: State<Database>,
) -> Result<BackupResult, String> {
    let config = load_config(&app);
    let dir = config
        .directory
        .as_ref()
        .ok_or_else(|| "请先设置备份目录".to_string())?;
    let backup_dir = PathBuf::from(dir);
    std::fs::create_dir_all(&backup_dir).map_err(|e| format!("无法创建备份目录: {}", e))?;

    let db_path = &db.path;

    if !db_changed(db_path, &config) {
        return Ok(BackupResult {
            success: true,
            path: None,
            message: Some("数据库无变化，跳过备份".to_string()),
        });
    }

    let now = chrono::Local::now();
    let filename = format!("portfolio_{}.db", now.format("%Y-%m-%d_%H-%M-%S"));
    let dest = backup_dir.join(&filename);

    std::fs::copy(db_path, &dest).map_err(|e| format!("备份失败: {}", e))?;

    let mut new_config = config;
    new_config.last_backup_mtime = file_mtime_secs(db_path);
    new_config.last_backup_size = file_size(db_path);
    new_config.last_backup_time = Some(now.to_rfc3339());
    save_config(&app, &new_config)?;

    Ok(BackupResult {
        success: true,
        path: Some(dest.to_string_lossy().to_string()),
        message: None,
    })
}

/// Called on app startup to perform auto-backup if enabled and needed.
pub fn auto_backup_if_needed(app: &tauri::AppHandle) {
    let config = load_config(app);
    if !config.auto_backup || config.directory.is_none() {
        return;
    }

    let db_path = app
        .path()
        .app_data_dir()
        .expect("app data dir")
        .join("portfolio.db");
    let db_path_str = db_path.to_string_lossy().to_string();

    if !db_changed(&db_path_str, &config) {
        return;
    }

    // Check if last backup was > 7 days ago
    if let Some(ref last_time) = config.last_backup_time {
        if let Ok(last) = chrono::DateTime::parse_from_rfc3339(last_time) {
            let last_utc: chrono::DateTime<chrono::Utc> = last.into();
            let days_since = (chrono::Utc::now() - last_utc).num_days();
            if days_since < 7 {
                return;
            }
        }
    }

    let backup_dir = std::path::PathBuf::from(config.directory.as_ref().unwrap());
    if let Err(e) = std::fs::create_dir_all(&backup_dir) {
        eprintln!("[auto-backup] failed to create dir: {}", e);
        return;
    }

    let now = chrono::Local::now();
    let filename = format!("portfolio_{}.db", now.format("%Y-%m-%d_%H-%M-%S"));
    let dest = backup_dir.join(&filename);

    match std::fs::copy(&db_path_str, &dest) {
        Ok(_) => {
            eprintln!("[auto-backup] saved to {}", dest.display());
            let mut new_config = config;
            new_config.last_backup_mtime = file_mtime_secs(&db_path_str);
            new_config.last_backup_size = file_size(&db_path_str);
            new_config.last_backup_time = Some(chrono::Utc::now().to_rfc3339());
            if let Err(e) = save_config(app, &new_config) {
                eprintln!("[auto-backup] failed to save config: {}", e);
            }
        }
        Err(e) => eprintln!("[auto-backup] failed: {}", e),
    }
}
