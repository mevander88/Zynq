use crate::model::{AppConfig, CommandError};
use crate::validation::validate_config;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_CONFIG_SIZE: u64 = 1024 * 1024;

pub fn load(path: &Path) -> Result<AppConfig, CommandError> {
    if !path.exists() { return Ok(AppConfig::default()); }
    let metadata = fs::metadata(path).map_err(io_error)?;
    if metadata.len() > MAX_CONFIG_SIZE { return Err(CommandError::new("CONFIG_TOO_LARGE", "config.json melebihi batas 1 MiB.")); }
    let bytes = fs::read(path).map_err(io_error)?;
    let config: AppConfig = serde_json::from_slice(&bytes).map_err(|error| CommandError::new("CONFIG_INVALID", format!("config.json tidak dapat dibaca: {error}")))?;
    validate_config(&config)?;
    Ok(config)
}

pub fn save(path: &Path, config: &AppConfig) -> Result<(), CommandError> {
    validate_config(config)?;
    let parent = path.parent().ok_or_else(|| CommandError::new("CONFIG_PATH", "Lokasi konfigurasi tidak valid."))?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let bytes = serde_json::to_vec_pretty(config).map_err(|error| CommandError::new("CONFIG_SERIALIZE", error.to_string()))?;
    if bytes.len() as u64 > MAX_CONFIG_SIZE { return Err(CommandError::new("CONFIG_TOO_LARGE", "Konfigurasi melebihi batas 1 MiB.")); }
    let temp = unique_temp_path(path);
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp).map_err(io_error)?;
        file.write_all(&bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        let backup = path.with_extension("json.bak");
        if path.exists() {
            fs::copy(path, &backup).map_err(io_error)?;
            #[cfg(windows)]
            { fs::remove_file(path).map_err(io_error)?; }
        }
        fs::rename(&temp, path).map_err(io_error)?;
        sync_parent(parent);
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result
}

fn unique_temp_path(path: &Path) -> PathBuf {
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    path.with_extension(format!("json.{nonce}.tmp"))
}

fn sync_parent(parent: &Path) { if let Ok(file) = OpenOptions::new().read(true).open(parent) { let _ = file.sync_all(); } }
fn io_error(error: std::io::Error) -> CommandError { CommandError::new("CONFIG_IO", format!("Konfigurasi tidak dapat diakses: {error}")) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn round_trip_config() { let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("config.json"); let mut config = AppConfig::default(); config.revision = 1; save(&path, &config).unwrap(); assert_eq!(load(&path).unwrap(), config); }
    #[test] fn rejects_unknown_fields() { let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("config.json"); fs::write(&path, br#"{"schemaVersion":1,"revision":1,"live":{"username":""},"rules":[],"ui":{"logVisible":true},"extra":1}"#).unwrap(); assert_eq!(load(&path).unwrap_err().code, "CONFIG_INVALID"); }
}
