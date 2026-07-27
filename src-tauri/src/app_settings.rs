use serde::Serialize;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettingsResponse {
    path: String,
    settings: serde_json::Value,
}

fn app_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("settings.json"))
        .map_err(|error| format!("无法定位应用设置目录：{error}"))
}

#[tauri::command]
pub(crate) fn read_app_settings(app: AppHandle) -> Result<AppSettingsResponse, String> {
    let path = app_settings_path(&app)?;
    let settings = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<serde_json::Value>(&text)
            .map_err(|error| format!("应用设置解析失败：{error}"))?,
        Err(error) if error.kind() == ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(format!("无法读取应用设置：{error}")),
    };

    Ok(AppSettingsResponse {
        path: path.to_string_lossy().to_string(),
        settings,
    })
}

#[tauri::command]
pub(crate) fn write_app_settings(
    app: AppHandle,
    settings: serde_json::Value,
) -> Result<(), String> {
    if !settings.is_object() {
        return Err("应用设置必须是 JSON 对象".to_string());
    }

    let path = app_settings_path(&app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "应用设置目录无效".to_string())?;
    fs::create_dir_all(dir).map_err(|error| format!("无法创建应用设置目录：{error}"))?;

    let temp = dir.join("settings.json.tmp");
    let text = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("应用设置序列化失败：{error}"))?;
    fs::write(&temp, format!("{text}\n"))
        .map_err(|error| format!("无法写入应用设置临时文件：{error}"))?;
    fs::rename(&temp, &path).map_err(|error| format!("无法保存应用设置：{error}"))
}

#[tauri::command]
pub(crate) fn reveal_app_settings_file(app: AppHandle) -> Result<(), String> {
    let path = app_settings_path(&app)?;
    if !path.exists() {
        write_app_settings(app, serde_json::json!({ "version": 1 }))?;
    }

    let status = Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|error| format!("无法在 Finder 中定位设置文件：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Finder 定位设置文件失败".to_string())
    }
}
