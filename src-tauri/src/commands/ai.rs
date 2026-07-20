use crate::db::Database;
use crate::models::ai_config::{AiConfig, AiModelInfo};
use crate::services::ai_config_service;
use crate::services::ai_models_service::{self, FetchModelsParams};
use serde::Deserialize;
use tauri::State;

#[tauri::command(rename_all = "camelCase")]
pub async fn get_ai_config(db: State<'_, Database>) -> Result<AiConfig, String> {
    ai_config_service::get_ai_config(&db)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn update_ai_config(
    db: State<'_, Database>,
    config: AiConfig,
) -> Result<bool, String> {
    ai_config_service::update_ai_config(&db, &config)
}

/// Request body for `fetch_ai_models`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchModelsRequest {
    pub provider: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: Option<String>,
}

/// Fetch the list of models available for a provider using the supplied
/// credentials. Returns an error string when the API is unreachable or the
/// credentials are invalid; the UI falls back to manual entry in that case.
#[tauri::command(rename_all = "camelCase")]
pub async fn fetch_ai_models(req: FetchModelsRequest) -> Result<Vec<AiModelInfo>, String> {
    ai_models_service::fetch_models(FetchModelsParams {
        provider: req.provider,
        api_key: req.api_key,
        base_url: req.base_url,
    })
    .await
}
