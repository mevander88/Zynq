use crate::model::{CommandError, TargetWindow};
use crate::rules::InputBatch;
use crate::windows::is_target_foreground;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};

#[derive(Clone)]
pub struct InputWorker {
    tx: mpsc::Sender<InputBatch>,
    generation: watch::Sender<u64>,
    target: Arc<Mutex<Option<TargetWindow>>>,
}

#[derive(Clone, Debug)]
pub enum WorkerEvent { Started, Completed(u32), Dropped(String), Fault(String) }

impl InputWorker {
    pub fn start(event_tx: mpsc::UnboundedSender<WorkerEvent>) -> Self {
        let (tx, mut rx) = mpsc::channel::<InputBatch>(100);
        let (generation, mut generation_rx) = watch::channel(0u64);
        let target = Arc::new(Mutex::new(None::<TargetWindow>));
        let worker_target = target.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(batch) = rx.recv().await {
                let current_generation = *generation_rx.borrow();
                if batch.generation != current_generation || batch.enqueued_at.elapsed() > Duration::from_secs(5) { let _ = event_tx.send(WorkerEvent::Dropped("Action kedaluwarsa atau dibatalkan.".into())); continue; }
                let target = worker_target.lock().ok().and_then(|guard| guard.clone());
                let Some(target) = target else { let _ = event_tx.send(WorkerEvent::Dropped("Target input belum dipilih.".into())); continue; };
                if !is_target_foreground(&target) { let _ = event_tx.send(WorkerEvent::Fault("Target tidak berada di foreground.".into())); continue; }
                let _ = event_tx.send(WorkerEvent::Started);
                let deadline = Instant::now() + Duration::from_secs(10);
                let mut completed = 0;
                for index in 0..batch.repeats {
                    if *generation_rx.borrow() != batch.generation || Instant::now() + Duration::from_millis(batch.rule.hold_ms) > deadline { break; }
                    if !is_target_foreground(&target) { let _ = event_tx.send(WorkerEvent::Fault("Fokus target berpindah ketika input berjalan.".into())); break; }
                    match send_chord(&batch.rule.keys, true) {
                        Ok(()) => {
                            let hold = tokio::time::sleep(Duration::from_millis(batch.rule.hold_ms));
                            tokio::pin!(hold);
                            tokio::select! { _ = &mut hold => {}, changed = generation_rx.changed() => { let _ = changed; } }
                            if let Err(error) = send_chord(&batch.rule.keys, false) { let _ = event_tx.send(WorkerEvent::Fault(error.message)); break; }
                            completed += 1;
                        }
                        Err(error) => { let _ = send_chord(&batch.rule.keys, false); let _ = event_tx.send(WorkerEvent::Fault(error.message)); break; }
                    }
                    if index + 1 < batch.repeats {
                        let wait = tokio::time::sleep(Duration::from_millis(batch.rule.repeat_gap_ms.max(100)));
                        tokio::pin!(wait);
                        tokio::select! { _ = &mut wait => {}, changed = generation_rx.changed() => { let _ = changed; } }
                    }
                }
                let _ = event_tx.send(WorkerEvent::Completed(completed));
            }
        });
        Self { tx, generation, target }
    }
    pub fn set_target(&self, target: Option<TargetWindow>) { if let Ok(mut guard) = self.target.lock() { *guard = target; } }
    pub fn cancel(&self, generation: u64) { let _ = self.generation.send(generation); }
    pub fn enqueue(&self, batch: InputBatch) -> Result<(), CommandError> { self.tx.try_send(batch).map_err(|_| CommandError::new("INPUT_QUEUE_FULL", "Antrean input penuh; gift tidak dijalankan.")) }
}

#[cfg(windows)]
fn send_chord(keys: &[String], down: bool) -> Result<(), CommandError> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE};
    if keys.is_empty() { return Err(CommandError::new("EMPTY_CHORD", "Keybind kosong.")); }
    let order: Vec<&String> = if down { keys.iter().collect() } else { keys.iter().rev().collect() };
    if down {
        for key in &order {
            let (_, virtual_key, _) = key_codes(key).ok_or_else(|| CommandError::new("UNSUPPORTED_KEY", format!("Tombol {key} tidak didukung.")))?;
            let pressed = unsafe { GetAsyncKeyState(virtual_key as i32) } as u16 & 0x8000 != 0;
            if pressed { return Err(CommandError::new("PHYSICAL_KEY_CONFLICT", format!("Tombol {key} sedang ditekan secara fisik."))); }
        }
    }
    let mut inputs = Vec::with_capacity(order.len());
    for key in order {
        let (scan, _, extended) = key_codes(key).ok_or_else(|| CommandError::new("UNSUPPORTED_KEY", format!("Tombol {key} tidak didukung.")))?;
        let mut flags = KEYEVENTF_SCANCODE;
        if extended { flags |= KEYEVENTF_EXTENDEDKEY; }
        if !down { flags |= KEYEVENTF_KEYUP; }
        inputs.push(INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: 0, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
    }
    let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 { return Err(CommandError::new("SEND_INPUT_FAILED", format!("Windows menerima {sent} dari {} input.", inputs.len()))); }
    Ok(())
}

#[cfg(not(windows))]
fn send_chord(_: &[String], _: bool) -> Result<(), CommandError> { Err(CommandError::new("UNSUPPORTED_PLATFORM", "Keyboard automation hanya tersedia di Windows.")) }

#[cfg(windows)]
fn key_codes(key: &str) -> Option<(u16, u16, bool)> {
    let value = match key {
        "ControlLeft" => (0x1D, 0xA2, false), "ShiftLeft" => (0x2A, 0xA0, false), "AltLeft" => (0x38, 0xA4, false),
        "Space" => (0x39, 0x20, false), "Enter" => (0x1C, 0x0D, false), "Tab" => (0x0F, 0x09, false), "Escape" => (0x01, 0x1B, false),
        "ArrowUp" => (0x48, 0x26, true), "ArrowDown" => (0x50, 0x28, true), "ArrowLeft" => (0x4B, 0x25, true), "ArrowRight" => (0x4D, 0x27, true),
        "F1" => (0x3B, 0x70, false), "F2" => (0x3C, 0x71, false), "F3" => (0x3D, 0x72, false), "F4" => (0x3E, 0x73, false), "F5" => (0x3F, 0x74, false), "F6" => (0x40, 0x75, false), "F7" => (0x41, 0x76, false), "F8" => (0x42, 0x77, false), "F9" => (0x43, 0x78, false), "F11" => (0x57, 0x7A, false),
        _ if key.starts_with("Key") && key.len() == 4 => { let letter = key.as_bytes()[3]; let scans = [0x1E,0x30,0x2E,0x20,0x12,0x21,0x22,0x23,0x17,0x24,0x25,0x26,0x32,0x31,0x18,0x19,0x10,0x13,0x1F,0x14,0x16,0x2F,0x11,0x2D,0x15,0x2C]; return (b'A'..=b'Z').contains(&letter).then(|| (scans[(letter-b'A') as usize], letter as u16, false)); },
        _ if key.starts_with("Digit") && key.len() == 6 => { let digit = key.as_bytes()[5]; let scans = [0x0B,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0A]; return digit.is_ascii_digit().then(|| (scans[(digit-b'0') as usize], digit as u16, false)); },
        _ => return None,
    };
    Some(value)
}
