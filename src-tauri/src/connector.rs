use crate::model::{CommandError, GiftCatalogItem};
use crate::rules::GiftObservation;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex};

const MAX_LINE_BYTES: usize = 16 * 1024;

#[derive(Debug)]
pub enum ConnectorEvent {
    Ready,
    State { status: String, room_id: Option<String>, transport: Option<String>, reason: Option<String> },
    Gift(GiftObservation),
    GiftCatalog(Vec<GiftCatalogItem>),
    Error { code: String, message: String, retryable: bool },
    Exited(String),
}

#[derive(Clone)]
pub struct ConnectorClient {
    process_id: String,
    connection_id: String,
    seq: Arc<AtomicU64>,
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IncomingEnvelope {
    protocol_version: u32,
    r#type: String,
    process_id: String,
    connection_id: Option<String>,
    seq: u64,
    request_id: Option<String>,
    payload: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutgoingEnvelope<'a> {
    protocol_version: u32,
    r#type: &'a str,
    process_id: &'a str,
    connection_id: Option<&'a str>,
    seq: u64,
    request_id: String,
    payload: Value,
}

impl ConnectorClient {
    pub async fn spawn(event_tx: mpsc::UnboundedSender<ConnectorEvent>, username: &str, mock_mode: bool) -> Result<Self, CommandError> {
        let (executable, script) = connector_paths()?;
        let mut command = Command::new(&executable);
        command.arg(&script).current_dir(script.parent().unwrap_or(Path::new("."))).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)]
        { command.creation_flags(0x08000000); }
        command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
        let mut child = command.spawn().map_err(|error| CommandError::new("CONNECTOR_SPAWN", format!("Connector tidak dapat dimulai: {error}")))?;
        let stdin = child.stdin.take().ok_or_else(|| CommandError::new("CONNECTOR_PIPE", "stdin connector tidak tersedia."))?;
        let stdout = child.stdout.take().ok_or_else(|| CommandError::new("CONNECTOR_PIPE", "stdout connector tidak tersedia."))?;
        let stderr = child.stderr.take().ok_or_else(|| CommandError::new("CONNECTOR_PIPE", "stderr connector tidak tersedia."))?;
        let process_id = unique_id("process");
        let connection_id = unique_id("connection");
        let client = Self { process_id, connection_id, seq: Arc::new(AtomicU64::new(0)), stdin: Arc::new(Mutex::new(stdin)), child: Arc::new(Mutex::new(child)) };
        spawn_stdout_reader(stdout, client.process_id.clone(), client.connection_id.clone(), event_tx.clone());
        spawn_stderr_reader(stderr, event_tx);
        client.send("hello", None, json!({"features":["gift","heartbeat"]})).await?;
        client.send("connect", Some(&client.connection_id), json!({"username":username,"mockMode":mock_mode})).await?;
        Ok(client)
    }

    pub async fn send_mock_gift(&self, gift: &GiftObservation) -> Result<(), CommandError> {
        self.send("mock_gift", Some(&self.connection_id), serde_json::to_value(gift).map_err(|error| CommandError::new("SERIALIZE", error.to_string()))?).await
    }

    pub async fn request_gift_catalog(&self) -> Result<(), CommandError> {
        self.send("refresh_gift_catalog", Some(&self.connection_id), json!({})).await
    }

    pub async fn shutdown(&self) {
        let _ = self.send("shutdown", Some(&self.connection_id), json!({})).await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let mut child = self.child.lock().await;
        match child.try_wait() { Ok(Some(_)) => {}, _ => { let _ = child.kill().await; } }
        let _ = child.wait().await;
    }

    async fn send(&self, message_type: &str, connection_id: Option<&str>, payload: Value) -> Result<(), CommandError> {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let envelope = OutgoingEnvelope { protocol_version: 1, r#type: message_type, process_id: &self.process_id, connection_id, seq, request_id: format!("request-{seq}"), payload };
        let mut line = serde_json::to_vec(&envelope).map_err(|error| CommandError::new("IPC_SERIALIZE", error.to_string()))?;
        line.push(b'\n');
        if line.len() > MAX_LINE_BYTES { return Err(CommandError::new("IPC_TOO_LARGE", "Pesan connector melebihi 16 KiB.")); }
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&line).await.map_err(|error| CommandError::new("IPC_WRITE", format!("Connector tidak merespons: {error}")))?;
        stdin.flush().await.map_err(|error| CommandError::new("IPC_WRITE", error.to_string()))
    }
}

fn spawn_stdout_reader(stdout: tokio::process::ChildStdout, process_id: String, connection_id: String, event_tx: mpsc::UnboundedSender<ConnectorEvent>) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut expected_seq = 1u64;
        while let Ok(Some(line)) = lines.next_line().await {
            if line.len() > MAX_LINE_BYTES { let _ = event_tx.send(ConnectorEvent::Exited("Pesan connector terlalu besar.".into())); return; }
            let envelope: IncomingEnvelope = match serde_json::from_str(&line) { Ok(value) => value, Err(_) => { let _ = event_tx.send(ConnectorEvent::Exited("Pesan connector tidak valid.".into())); return; } };
            if envelope.protocol_version != 1 || envelope.process_id != process_id || envelope.seq != expected_seq { let _ = event_tx.send(ConnectorEvent::Exited("Urutan atau identity connector tidak valid.".into())); return; }
            expected_seq += 1;
            if envelope.r#type != "ready" && envelope.connection_id.as_deref() != Some(connection_id.as_str()) { let _ = event_tx.send(ConnectorEvent::Exited("Pesan berasal dari attempt lama.".into())); return; }
            let event = match envelope.r#type.as_str() {
                "ready" => Some(ConnectorEvent::Ready),
                "connection_state" => Some(ConnectorEvent::State { status: envelope.payload.get("status").and_then(Value::as_str).unwrap_or("error").to_string(), room_id: envelope.payload.get("roomId").and_then(Value::as_str).map(str::to_string), transport: envelope.payload.get("transport").and_then(Value::as_str).map(str::to_string), reason: envelope.payload.get("reason").and_then(Value::as_str).map(str::to_string) }),
                "gift" => serde_json::from_value(envelope.payload).map(ConnectorEvent::Gift).ok(),
                "gift_catalog" => Some(match parse_gift_catalog(envelope.payload) {
                    Some(gifts) => ConnectorEvent::GiftCatalog(gifts),
                    None => ConnectorEvent::Error { code: "GIFT_CATALOG_FAILED".into(), message: "Daftar gift yang diterima tidak valid.".into(), retryable: true },
                }),
                "error" => Some(ConnectorEvent::Error { code: envelope.payload.get("code").and_then(Value::as_str).unwrap_or("CONNECTOR_ERROR").to_string(), message: envelope.payload.get("message").and_then(Value::as_str).unwrap_or("Connector error").chars().take(512).collect(), retryable: envelope.payload.get("retryable").and_then(Value::as_bool).unwrap_or(false) }),
                "ack" | "pong" => None,
                _ => { let _ = event_tx.send(ConnectorEvent::Exited("Tipe pesan connector tidak dikenal.".into())); return; }
            };
            if let Some(event) = event { let _ = event_tx.send(event); }
        }
        let _ = event_tx.send(ConnectorEvent::Exited("Connector berhenti.".into()));
    });
}

fn parse_gift_catalog(payload: Value) -> Option<Vec<GiftCatalogItem>> {
    let gifts: Vec<GiftCatalogItem> = serde_json::from_value(payload.get("gifts")?.clone()).ok()?;
    if gifts.len() > 100 { return None; }
    let valid = gifts.iter().all(|gift| {
        !gift.id.is_empty()
            && gift.id.len() <= 32
            && gift.id != "0"
            && gift.id.bytes().all(|byte| byte.is_ascii_digit())
            && !gift.name.is_empty()
            && gift.name.chars().count() <= 64
            && !gift.name.chars().any(char::is_control)
    });
    valid.then_some(gifts)
}

fn spawn_stderr_reader(stderr: tokio::process::ChildStderr, event_tx: mpsc::UnboundedSender<ConnectorEvent>) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut count = 0usize;
        while let Ok(Some(line)) = lines.next_line().await {
            if count < 20 { let _ = event_tx.send(ConnectorEvent::Error { code: "CONNECTOR_DIAGNOSTIC".into(), message: line.chars().take(256).collect(), retryable: false }); }
            count += 1;
        }
    });
}

fn connector_paths() -> Result<(PathBuf, PathBuf), CommandError> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev_script = manifest.join("..").join("connector").join("index.cjs");
    if dev_script.exists() { return Ok((PathBuf::from("node"), dev_script)); }
    let executable_dir = std::env::current_exe().map_err(|error| CommandError::new("CONNECTOR_PATH", error.to_string()))?.parent().map(Path::to_path_buf).ok_or_else(|| CommandError::new("CONNECTOR_PATH", "Direktori executable tidak ditemukan."))?;
    let node = executable_dir.join("node.exe");
    let script_candidates = [executable_dir.join("connector").join("index.cjs"), executable_dir.join("_up_").join("connector").join("index.cjs")];
    let script = script_candidates.into_iter().find(|path| path.exists()).ok_or_else(|| CommandError::new("CONNECTOR_PATH", "Resource connector tidak ditemukan."))?;
    if !node.exists() { return Err(CommandError::new("CONNECTOR_PATH", "Runtime Node terbundel tidak ditemukan.")); }
    Ok((node, script))
}

fn unique_id(prefix: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("{prefix}-{}-{nanos}", std::process::id())
}
