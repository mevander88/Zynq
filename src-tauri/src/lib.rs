mod config;
mod connector;
mod core;
mod hotkey;
mod keyboard;
mod model;
mod rules;
mod validation;
mod windows;

use core::AppCore;
use model::{AppConfig, AppSnapshot, CommandError, TargetWindow};
use std::sync::Arc;
use tauri::{Manager, State};

#[tauri::command]
fn get_snapshot(core: State<'_, Arc<AppCore>>) -> AppSnapshot { core.snapshot() }

#[tauri::command]
async fn connect_live(core: State<'_, Arc<AppCore>>, username: String, mock_mode: bool) -> Result<(), CommandError> { core.inner().connect(username, mock_mode).await }

#[tauri::command]
async fn disconnect_live(core: State<'_, Arc<AppCore>>) -> Result<(), CommandError> { core.disconnect().await; Ok(()) }

#[tauri::command]
fn save_config(core: State<'_, Arc<AppCore>>, config: AppConfig) -> Result<AppSnapshot, CommandError> { core.save_config(config) }

#[tauri::command]
fn list_targets() -> Vec<TargetWindow> { windows::list_targets() }

#[tauri::command]
fn select_target(core: State<'_, Arc<AppCore>>, hwnd: usize) -> Result<(), CommandError> { core.select_target(hwnd) }

#[tauri::command]
async fn start_automation(core: State<'_, Arc<AppCore>>) -> Result<(), CommandError> { core.start_automation().await }

#[tauri::command]
fn stop_automation(core: State<'_, Arc<AppCore>>) { core.stop_automation(); }

#[tauri::command]
fn emergency_stop(core: State<'_, Arc<AppCore>>) { core.emergency_stop(); }

#[tauri::command]
fn reset_emergency(core: State<'_, Arc<AppCore>>) -> Result<(), CommandError> { core.reset_emergency() }

#[tauri::command]
async fn emit_mock_gift(core: State<'_, Arc<AppCore>>, gift_id: String, repeat_count: u32, streak: bool) -> Result<(), CommandError> { core.emit_mock_gift(gift_id, repeat_count, streak).await }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| { if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); } }))
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let config_path = config_dir.join("config.json");
            let config = config::load(&config_path).unwrap_or_default();
            let core = AppCore::new(app.handle().clone(), config_path, config);
            hotkey::register_emergency(core.clone());
            app.manage(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_snapshot, connect_live, disconnect_live, save_config, list_targets, select_target, start_automation, stop_automation, emergency_stop, reset_emergency, emit_mock_gift])
        .run(tauri::generate_context!())
        .expect("failed to run Zynq desktop application");
}
