use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const MAX_RULES: usize = 200;
pub const MAX_LOGS: usize = 500;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppConfig {
    pub schema_version: u32,
    pub revision: u64,
    pub live: LiveConfig,
    pub rules: Vec<Rule>,
    pub ui: UiConfig,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            live: LiveConfig { username: String::new() },
            rules: vec![],
            ui: UiConfig { log_visible: true },
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveConfig { pub username: String }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiConfig { pub log_visible: bool }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RepeatMode { Once, PerUnit, Fixed }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub enabled: bool,
    pub gift_id: String,
    pub gift_label: String,
    pub priority: u8,
    pub keys: Vec<String>,
    pub hold_ms: u64,
    pub cooldown_ms: u64,
    pub repeat_mode: RepeatMode,
    pub fixed_count: u32,
    pub max_repeats: u32,
    pub repeat_gap_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus { Idle, Starting, Connecting, Connected, Reconnecting, Offline, Stopping, Error }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AutomationStatus { Disarmed, Arming, Armed, EmergencyLatched, Faulted }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetWindow {
    pub hwnd: usize,
    pub pid: u32,
    pub title: String,
    pub process_name: String,
    pub foreground: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GiftCatalogItem {
    pub id: String,
    pub name: String,
    pub diamond_count: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel { Info, Success, Warning, Error }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventLog {
    pub id: u64,
    pub timestamp: String,
    pub level: LogLevel,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub revision: u64,
    pub connection: ConnectionStatus,
    pub automation: AutomationStatus,
    pub room_id: Option<String>,
    pub username: String,
    pub transport: Option<String>,
    pub retry_attempt: u8,
    pub status_message: String,
    pub selected_target: Option<TargetWindow>,
    pub config: AppConfig,
    pub config_dirty: bool,
    pub queue_depth: usize,
    pub input_count: u64,
    pub dropped_count: u64,
    pub logs: Vec<EventLog>,
    pub mock_mode: bool,
    pub gift_catalog: Vec<GiftCatalogItem>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl CommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), field: None }
    }
    pub fn field(mut self, field: impl Into<String>) -> Self { self.field = Some(field.into()); self }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}", self.message) }
}

impl std::error::Error for CommandError {}

#[derive(Debug)]
pub struct RuntimeState {
    pub revision: u64,
    pub connection: ConnectionStatus,
    pub automation: AutomationStatus,
    pub room_id: Option<String>,
    pub username: String,
    pub transport: Option<String>,
    pub retry_attempt: u8,
    pub status_message: String,
    pub selected_target: Option<TargetWindow>,
    pub config: AppConfig,
    pub queue_depth: usize,
    pub input_count: u64,
    pub dropped_count: u64,
    pub logs: VecDeque<EventLog>,
    pub next_log_id: u64,
    pub mock_mode: bool,
    pub gift_catalog: Vec<GiftCatalogItem>,
    pub automation_generation: u64,
}

impl RuntimeState {
    pub fn new(config: AppConfig) -> Self {
        Self { revision: 1, connection: ConnectionStatus::Idle, automation: AutomationStatus::Disarmed, room_id: None, username: config.live.username.clone(), transport: None, retry_attempt: 0, status_message: "Siap menghubungkan LIVE".into(), selected_target: None, config, queue_depth: 0, input_count: 0, dropped_count: 0, logs: VecDeque::new(), next_log_id: 1, mock_mode: true, gift_catalog: vec![], automation_generation: 0 }
    }
    pub fn snapshot(&self) -> AppSnapshot {
        AppSnapshot { revision: self.revision, connection: self.connection.clone(), automation: self.automation.clone(), room_id: self.room_id.clone(), username: self.username.clone(), transport: self.transport.clone(), retry_attempt: self.retry_attempt, status_message: self.status_message.clone(), selected_target: self.selected_target.clone(), config: self.config.clone(), config_dirty: false, queue_depth: self.queue_depth, input_count: self.input_count, dropped_count: self.dropped_count, logs: self.logs.iter().cloned().collect(), mock_mode: self.mock_mode, gift_catalog: self.gift_catalog.clone() }
    }
    pub fn touch(&mut self) { self.revision = self.revision.saturating_add(1); }
    pub fn log(&mut self, level: LogLevel, message: impl Into<String>, detail: Option<String>) {
        let clean = |value: String| value.replace(['\r', '\n'], " ").chars().take(512).collect::<String>();
        let item = EventLog { id: self.next_log_id, timestamp: timestamp_now(), level, message: clean(message.into()), detail: detail.map(clean) };
        self.next_log_id = self.next_log_id.saturating_add(1);
        self.logs.push_back(item);
        while self.logs.len() > MAX_LOGS { self.logs.pop_front(); }
        self.touch();
    }
}

fn timestamp_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    format!("{millis}")
}
