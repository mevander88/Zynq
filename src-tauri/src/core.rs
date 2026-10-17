use crate::config;
use crate::connector::{ConnectorClient, ConnectorEvent};
use crate::keyboard::{InputWorker, WorkerEvent};
use crate::model::*;
use crate::rules::{GiftObservation, GiftOutcome, RuleEngine};
use crate::validation::{normalize_username, validate_config};
use crate::windows::{is_target_foreground, resolve_target};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex as AsyncMutex};

pub struct AppCore {
    app: AppHandle,
    state: Mutex<RuntimeState>,
    engine: Mutex<RuleEngine>,
    worker: InputWorker,
    connector: AsyncMutex<Option<ConnectorClient>>,
    config_path: PathBuf,
}

impl AppCore {
    pub fn new(app: AppHandle, config_path: PathBuf, config: AppConfig) -> Arc<Self> {
        let (worker_tx, mut worker_rx) = mpsc::unbounded_channel();
        let worker = InputWorker::start(worker_tx);
        let core = Arc::new(Self { app, state: Mutex::new(RuntimeState::new(config)), engine: Mutex::new(RuleEngine::default()), worker, connector: AsyncMutex::new(None), config_path });
        let callback_core = core.clone();
        tauri::async_runtime::spawn(async move { while let Some(event) = worker_rx.recv().await { callback_core.handle_worker_event(event); } });
        core.log(LogLevel::Info, "Zynq siap", Some("Automation dimulai dalam keadaan aman.".into()));
        core
    }

    pub fn snapshot(&self) -> AppSnapshot { self.state.lock().expect("state poisoned").snapshot() }

    pub async fn connect(self: &Arc<Self>, username: String, mock_mode: bool) -> Result<(), CommandError> {
        let normalized = if mock_mode && username.trim().is_empty() { "simulator".to_string() } else { normalize_username(&username)? };
        {
            let connector = self.connector.lock().await;
            if connector.is_some() { return Err(CommandError::new("ALREADY_CONNECTED", "Connector sudah berjalan.")); }
        }
        self.disarm("Koneksi baru disiapkan.");
        {
            let mut state = self.state.lock().expect("state poisoned");
            state.connection = ConnectionStatus::Starting; state.username = normalized.clone(); state.mock_mode = mock_mode; state.gift_catalog.clear(); state.status_message = "Menyiapkan connector".into(); state.log(LogLevel::Info, "Menyiapkan koneksi", Some(if mock_mode { "Mode simulasi".into() } else { format!("@{normalized}") }));
        }
        self.emit();
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let client = ConnectorClient::spawn(event_tx, &normalized, mock_mode).await.map_err(|error| { self.set_connection_error(&error.message); error })?;
        *self.connector.lock().await = Some(client);
        let core = self.clone();
        tauri::async_runtime::spawn(async move { while let Some(event) = event_rx.recv().await { core.handle_connector_event(event).await; } });
        Ok(())
    }

    pub async fn disconnect(&self) {
        self.disarm("LIVE diputuskan.");
        { let mut state = self.state.lock().expect("state poisoned"); state.connection = ConnectionStatus::Stopping; state.status_message = "Memutus koneksi".into(); state.touch(); }
        self.emit();
        if let Some(client) = self.connector.lock().await.take() { client.shutdown().await; }
        if let Ok(mut engine) = self.engine.lock() { engine.clear_room(); }
        { let mut state = self.state.lock().expect("state poisoned"); state.connection = ConnectionStatus::Idle; state.room_id = None; state.transport = None; state.gift_catalog.clear(); state.status_message = "Siap menghubungkan LIVE".into(); state.log(LogLevel::Info, "Koneksi diputuskan", None); }
        self.emit();
    }

    pub fn save_config(&self, mut next: AppConfig) -> Result<AppSnapshot, CommandError> {
        { let state = self.state.lock().expect("state poisoned"); if state.automation != AutomationStatus::Disarmed { return Err(CommandError::new("AUTOMATION_ACTIVE", "Stop automation sebelum menyimpan konfigurasi.")); } next.revision = state.config.revision.saturating_add(1); }
        validate_config(&next)?;
        config::save(&self.config_path, &next)?;
        { let mut state = self.state.lock().expect("state poisoned"); state.username = next.live.username.clone(); state.config = next; state.log(LogLevel::Success, "Konfigurasi tersimpan", None); }
        self.emit();
        Ok(self.snapshot())
    }

    pub fn select_target(&self, hwnd: usize) -> Result<(), CommandError> {
        let target = resolve_target(hwnd)?;
        self.disarm("Target input berubah.");
        self.worker.set_target(Some(target.clone()));
        { let mut state = self.state.lock().expect("state poisoned"); state.selected_target = Some(target.clone()); state.log(LogLevel::Info, "Target input dipilih", Some(format!("{} · PID {}", target.title, target.pid))); }
        self.emit(); Ok(())
    }

    pub async fn start_automation(&self) -> Result<(), CommandError> {
        let target;
        {
            let mut state = self.state.lock().expect("state poisoned");
            if !matches!(state.connection, ConnectionStatus::Connected) { return Err(CommandError::new("NOT_CONNECTED", "Hubungkan LIVE sebelum memulai automation.")); }
            if state.automation == AutomationStatus::EmergencyLatched { return Err(CommandError::new("EMERGENCY_LATCHED", "Reset emergency stop sebelum memulai automation.")); }
            if state.automation != AutomationStatus::Disarmed { return Err(CommandError::new("INVALID_STATE", "Automation belum berada dalam keadaan aman untuk dimulai.")); }
            validate_config(&state.config)?;
            target = state.selected_target.clone().ok_or_else(|| CommandError::new("TARGET_REQUIRED", "Pilih jendela target sebelum memulai automation."))?;
            if !is_target_foreground(&target) { return Err(CommandError::new("TARGET_NOT_FOREGROUND", "Aktifkan jendela target di foreground, lalu coba lagi.")); }
            state.automation = AutomationStatus::Arming; state.status_message = "Automation aktif dalam 3 detik".into(); state.touch();
        }
        self.emit();
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        if !is_target_foreground(&target) { self.disarm("Target kehilangan fokus saat countdown."); return Err(CommandError::new("TARGET_NOT_FOREGROUND", "Target kehilangan fokus selama countdown.")); }
        { let mut state = self.state.lock().expect("state poisoned"); if state.automation != AutomationStatus::Arming { return Err(CommandError::new("START_CANCELLED", "Start automation dibatalkan.")); } state.automation_generation = state.automation_generation.saturating_add(1); self.worker.cancel(state.automation_generation); state.automation = AutomationStatus::Armed; state.status_message = "Automation aktif; target harus tetap foreground".into(); state.log(LogLevel::Success, "Automation aktif", Some(target.title)); }
        self.emit(); Ok(())
    }

    pub fn stop_automation(&self) { self.disarm("Automation dihentikan."); self.log(LogLevel::Info, "Automation dihentikan", None); }

    pub fn emergency_stop(&self) {
        let generation = { let mut state = self.state.lock().expect("state poisoned"); state.automation_generation = state.automation_generation.saturating_add(1); state.automation = AutomationStatus::EmergencyLatched; state.queue_depth = 0; state.status_message = "Emergency stop terkunci".into(); state.log(LogLevel::Error, "EMERGENCY STOP", Some("Semua action dibatalkan; reset diperlukan.".into())); state.automation_generation };
        self.worker.cancel(generation);
        if let Ok(mut engine) = self.engine.lock() { engine.suppress_open_streaks(); }
        self.emit();
    }

    pub fn reset_emergency(&self) -> Result<(), CommandError> {
        let mut state = self.state.lock().expect("state poisoned");
        if state.automation != AutomationStatus::EmergencyLatched { return Err(CommandError::new("INVALID_STATE", "Emergency stop tidak sedang terkunci.")); }
        state.automation = AutomationStatus::Disarmed; state.status_message = "Emergency direset; automation tetap aman".into(); state.log(LogLevel::Info, "Emergency stop direset", None); drop(state); self.emit(); Ok(())
    }

    pub async fn emit_mock_gift(&self, gift_id: String, repeat_count: u32, streak: bool) -> Result<(), CommandError> {
        let (room_id, mock_mode) = { let state = self.state.lock().expect("state poisoned"); (state.room_id.clone(), state.mock_mode) };
        if !mock_mode { return Err(CommandError::new("MOCK_DISABLED", "Gift simulasi hanya tersedia dalam mode simulasi.")); }
        let room_id = room_id.ok_or_else(|| CommandError::new("NOT_CONNECTED", "Hubungkan simulator terlebih dahulu."))?;
        let client = self.connector.lock().await;
        let client = client.as_ref().ok_or_else(|| CommandError::new("NOT_CONNECTED", "Connector belum berjalan."))?;
        let identity = format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
        if streak {
            let progress = GiftObservation { connection_id: String::new(), room_id: room_id.clone(), msg_id: format!("{identity}1"), sender_id: "9001".into(), gift_id: gift_id.clone(), gift_type: 1, repeat_count, repeat_end: Some(false), group_id: Some(identity.clone()), gift_name: Some("Simulated gift".into()), sender_label: Some("simulator".into()), receiver_user_id: None };
            client.send_mock_gift(&progress).await?;
            let mut final_event = progress; final_event.msg_id = format!("{identity}2"); final_event.repeat_end = Some(true); client.send_mock_gift(&final_event).await?;
        } else {
            client.send_mock_gift(&GiftObservation { connection_id: String::new(), room_id, msg_id: identity, sender_id: "9001".into(), gift_id, gift_type: 0, repeat_count, repeat_end: None, group_id: None, gift_name: Some("Simulated gift".into()), sender_label: Some("simulator".into()), receiver_user_id: None }).await?;
        }
        Ok(())
    }

    async fn handle_connector_event(&self, event: ConnectorEvent) {
        match event {
            ConnectorEvent::Ready => self.log(LogLevel::Info, "Connector siap", None),
            ConnectorEvent::State { status, room_id, transport, reason } => {
                let mut state = self.state.lock().expect("state poisoned"); state.room_id = room_id; state.transport = transport;
                match status.as_str() { "connecting" => { state.connection = ConnectionStatus::Connecting; state.status_message = "Menghubungkan ke LIVE".into(); }, "connected" => { state.connection = ConnectionStatus::Connected; state.retry_attempt = 0; state.status_message = "LIVE terhubung; automation tetap aman".into(); state.log(LogLevel::Success, "LIVE terhubung", None); }, "offline" => { state.connection = ConnectionStatus::Offline; state.status_message = "LIVE offline atau koneksi terputus".into(); state.log(LogLevel::Warning, "Koneksi terputus", reason); }, _ => { state.connection = ConnectionStatus::Error; state.status_message = "Connector melaporkan state tidak dikenal".into(); state.touch(); } }
                drop(state); if status == "offline" { self.disarm("Koneksi LIVE terputus."); } self.emit();
            }
            ConnectorEvent::Gift(gift) => self.process_gift(gift),
            ConnectorEvent::GiftCatalog(gifts) => {
                let count = gifts.len();
                let mut state = self.state.lock().expect("state poisoned");
                state.gift_catalog = gifts;
                state.log(LogLevel::Info, "Daftar gift tersedia", Some(format!("{count} jenis gift dapat dipilih.")));
                drop(state);
                self.emit();
            },
            ConnectorEvent::Error { code, message, retryable } => self.log(if retryable { LogLevel::Warning } else { LogLevel::Error }, message, Some(code)),
            ConnectorEvent::Exited(message) => { self.set_connection_error(&message); self.disarm("Connector berhenti."); *self.connector.lock().await = None; }
        }
    }

    fn process_gift(&self, gift: GiftObservation) {
        let (rules, armed, generation) = { let state = self.state.lock().expect("state poisoned"); (state.config.rules.clone(), state.automation == AutomationStatus::Armed, state.automation_generation) };
        let outcome = self.engine.lock().expect("engine poisoned").process(gift, &rules, armed, generation);
        match outcome {
            GiftOutcome::Progress { count, gift_id } => self.log(LogLevel::Info, format!("Streak gift {gift_id} ×{count}"), Some("Menunggu event final".into())),
            GiftOutcome::Batch(batch) => { let label = batch.rule.gift_label.clone(); let repeats = batch.repeats; match self.worker.enqueue(batch) { Ok(()) => { let mut state = self.state.lock().expect("state poisoned"); state.queue_depth = (state.queue_depth + 1).min(100); state.log(LogLevel::Success, format!("Gift diterima: {label}"), Some(format!("{repeats} action dijadwalkan"))); }, Err(error) => { let mut state = self.state.lock().expect("state poisoned"); state.dropped_count += 1; state.log(LogLevel::Error, error.message, Some(error.code)); } } self.emit(); },
            GiftOutcome::Cooldown => { let mut state = self.state.lock().expect("state poisoned"); state.dropped_count += 1; state.log(LogLevel::Warning, "Gift dilewati karena cooldown", None); drop(state); self.emit(); },
            GiftOutcome::NoMatch => self.log(LogLevel::Info, "Gift tidak memiliki aturan aktif", None),
            GiftOutcome::Invalid(reason) => { let mut state = self.state.lock().expect("state poisoned"); state.dropped_count += 1; state.log(LogLevel::Error, "Gift ditolak", Some(reason)); drop(state); self.emit(); },
            GiftOutcome::Duplicate => {}
        }
    }

    fn handle_worker_event(&self, event: WorkerEvent) {
        let mut state = self.state.lock().expect("state poisoned");
        match event { WorkerEvent::Started => { state.queue_depth = state.queue_depth.saturating_sub(1); state.touch(); }, WorkerEvent::Completed(count) => { state.input_count = state.input_count.saturating_add(count as u64); state.log(LogLevel::Success, "Input dikirim ke Windows", Some(format!("{count} chord selesai"))); }, WorkerEvent::Dropped(reason) => { state.queue_depth = state.queue_depth.saturating_sub(1); state.dropped_count += 1; state.log(LogLevel::Warning, "Action dilewati", Some(reason)); }, WorkerEvent::Fault(reason) => { state.automation_generation = state.automation_generation.saturating_add(1); self.worker.cancel(state.automation_generation); state.automation = AutomationStatus::Faulted; state.queue_depth = 0; state.status_message = "Input automation mengalami fault".into(); state.log(LogLevel::Error, "Input dihentikan", Some(reason)); } }
        drop(state); self.emit();
    }

    fn disarm(&self, reason: &str) {
        let generation = { let mut state = self.state.lock().expect("state poisoned"); state.automation_generation = state.automation_generation.saturating_add(1); if state.automation != AutomationStatus::EmergencyLatched { state.automation = AutomationStatus::Disarmed; } state.queue_depth = 0; state.status_message = reason.into(); state.touch(); state.automation_generation };
        self.worker.cancel(generation); if let Ok(mut engine) = self.engine.lock() { engine.suppress_open_streaks(); } self.emit();
    }
    fn set_connection_error(&self, message: &str) { let mut state = self.state.lock().expect("state poisoned"); state.connection = ConnectionStatus::Error; state.status_message = "Connector gagal berjalan".into(); state.log(LogLevel::Error, "Connector gagal", Some(message.chars().take(512).collect())); drop(state); self.emit(); }
    fn log(&self, level: LogLevel, message: impl Into<String>, detail: Option<String>) { self.state.lock().expect("state poisoned").log(level, message, detail); self.emit(); }
    fn emit(&self) { let _ = self.app.emit("snapshot", self.snapshot()); }
}
