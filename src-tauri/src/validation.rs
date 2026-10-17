use crate::model::{AppConfig, CommandError, RepeatMode, Rule, MAX_RULES};
use std::collections::HashSet;

const SUPPORTED_KEYS: &[&str] = &[
    "Space", "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F11",
];
const MODIFIERS: &[&str] = &["ControlLeft", "ShiftLeft", "AltLeft"];

pub fn normalize_username(input: &str) -> Result<String, CommandError> {
    let value = input.trim().strip_prefix('@').unwrap_or(input.trim());
    if value.is_empty() || value.len() > 64 || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_')) {
        return Err(CommandError::new("INVALID_USERNAME", "Username harus 1–64 karakter dan hanya berisi huruf, angka, titik, atau underscore.").field("username"));
    }
    Ok(value.to_string())
}

pub fn validate_config(config: &AppConfig) -> Result<(), CommandError> {
    if config.schema_version != 1 { return Err(CommandError::new("UNSUPPORTED_CONFIG", "schemaVersion konfigurasi harus 1.").field("schemaVersion")); }
    if config.rules.len() > MAX_RULES { return Err(CommandError::new("TOO_MANY_RULES", format!("Maksimal {MAX_RULES} aturan.")).field("rules")); }
    if !config.live.username.is_empty() { normalize_username(&config.live.username)?; }
    let mut ids = HashSet::new();
    let mut active_gifts = HashSet::new();
    for rule in &config.rules {
        validate_rule(rule)?;
        if !ids.insert(&rule.id) { return Err(CommandError::new("DUPLICATE_RULE_ID", "Setiap rule harus memiliki ID unik.").field("rules")); }
        if rule.enabled && !active_gifts.insert(&rule.gift_id) { return Err(CommandError::new("DUPLICATE_ACTIVE_GIFT", format!("Gift ID {} memiliki lebih dari satu aturan aktif.", rule.gift_id)).field("rules")); }
    }
    Ok(())
}

fn validate_rule(rule: &Rule) -> Result<(), CommandError> {
    let invalid = |message: String| CommandError::new("INVALID_RULE", message).field(format!("rules.{}", rule.id));
    if rule.id.is_empty() || rule.id.len() > 64 || !rule.id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) { return Err(invalid("Rule ID tidak valid.".into())); }
    if rule.gift_id.is_empty() || rule.gift_id.len() > 32 || rule.gift_id == "0" || !rule.gift_id.bytes().all(|byte| byte.is_ascii_digit()) { return Err(invalid("Gift ID harus berupa angka positif maksimal 32 digit.".into())); }
    if rule.gift_label.chars().count() > 128 || rule.gift_label.chars().any(char::is_control) { return Err(invalid("Label gift maksimal 128 karakter tanpa karakter kontrol.".into())); }
    if rule.hold_ms < 10 || rule.hold_ms > 5_000 { return Err(invalid("Durasi tekan harus 10–5000 ms.".into())); }
    if rule.cooldown_ms > 600_000 { return Err(invalid("Cooldown maksimal 600000 ms.".into())); }
    if rule.fixed_count < 1 || rule.fixed_count > 50 || rule.max_repeats < 1 || rule.max_repeats > 50 || rule.fixed_count > rule.max_repeats { return Err(invalid("Jumlah pengulangan harus 1–50 dan fixedCount tidak boleh melebihi maxRepeats.".into())); }
    if rule.repeat_gap_ms < 50 || rule.repeat_gap_ms > 5_000 { return Err(invalid("Jeda repeat harus 50–5000 ms.".into())); }
    if rule.keys.is_empty() || rule.keys.len() > 4 { return Err(invalid("Keybind harus memiliki satu tombol utama dan maksimal tiga modifier.".into())); }
    let main = rule.keys.last().expect("checked nonempty");
    if !is_main_key(main) { return Err(invalid(format!("Tombol {main} tidak didukung."))); }
    let mut seen = HashSet::new();
    for modifier in &rule.keys[..rule.keys.len() - 1] {
        if !MODIFIERS.contains(&modifier.as_str()) || !seen.insert(modifier) { return Err(invalid("Modifier tidak didukung atau duplikat.".into())); }
    }
    if matches!((rule.keys.first().map(String::as_str), main.as_str()), (Some("AltLeft"), "F4") | (Some("AltLeft"), "Tab") | (Some("AltLeft"), "Escape")) { return Err(invalid("Kombinasi tombol ini dilindungi dan tidak boleh digunakan.".into())); }
    let _ = &rule.repeat_mode as *const RepeatMode;
    Ok(())
}

fn is_main_key(key: &str) -> bool {
    (key.len() == 4 && key.starts_with("Key") && key.as_bytes()[3].is_ascii_uppercase())
        || (key.len() == 6 && key.starts_with("Digit") && key.as_bytes()[5].is_ascii_digit())
        || SUPPORTED_KEYS.contains(&key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{LiveConfig, UiConfig};
    fn rule(gift: &str) -> Rule { Rule { id: format!("r-{gift}"), enabled: true, gift_id: gift.into(), gift_label: String::new(), priority: 50, keys: vec!["Space".into()], hold_ms: 100, cooldown_ms: 1000, repeat_mode: RepeatMode::Once, fixed_count: 1, max_repeats: 10, repeat_gap_ms: 100 } }
    #[test] fn rejects_duplicate_enabled_gifts() { let config = AppConfig { schema_version: 1, revision: 1, live: LiveConfig { username: String::new() }, rules: vec![rule("1"), { let mut item = rule("1"); item.id = "r-2".into(); item }], ui: UiConfig { log_visible: true } }; assert_eq!(validate_config(&config).unwrap_err().code, "DUPLICATE_ACTIVE_GIFT"); }
    #[test] fn rejects_reserved_alt_f4() { let mut item = rule("1"); item.keys = vec!["AltLeft".into(), "F4".into()]; assert_eq!(validate_rule(&item).unwrap_err().code, "INVALID_RULE"); }
    #[test] fn normalizes_username() { assert_eq!(normalize_username(" @hello.world ").unwrap(), "hello.world"); assert!(normalize_username("bad name").is_err()); }
}
