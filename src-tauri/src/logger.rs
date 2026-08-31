use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use chrono::{Local, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};

pub const MAX_IN_MEMORY_LOGS: usize = 3000;
pub const MAX_LOG_FILE_DAYS: i64 = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Trace => "TRACE",
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogChannel {
    Git,
    Svn,
    Core,
    Ui,
}

impl LogChannel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Git => "GIT",
            Self::Svn => "SVN",
            Self::Core => "CORE",
            Self::Ui => "UI",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: LogLevel,
    pub channel: LogChannel,
    pub message: String,
    pub details: Option<String>,
    pub duration_ms: Option<u32>,
    pub exit_code: Option<i32>,
}

pub struct LogManager {
    log_dir: PathBuf,
    entries: Mutex<VecDeque<LogEntry>>,
    app_handle: Mutex<Option<AppHandle>>,
}

static GLOBAL_LOGGER: std::sync::OnceLock<Arc<LogManager>> = std::sync::OnceLock::new();

pub fn init_global_logger(log_dir: PathBuf) -> Arc<LogManager> {
    let manager = Arc::new(LogManager::new(log_dir));
    let _ = GLOBAL_LOGGER.set(manager.clone());
    manager
}

pub fn get_logger() -> Option<Arc<LogManager>> {
    GLOBAL_LOGGER.get().cloned()
}

pub fn log_entry(
    level: LogLevel,
    channel: LogChannel,
    message: impl Into<String>,
    details: Option<String>,
    duration_ms: Option<u32>,
    exit_code: Option<i32>,
) {
    if let Some(logger) = get_logger() {
        let entry = LogEntry {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: Utc::now().to_rfc3339(),
            level,
            channel,
            message: crate::cli::redact(&message.into()),
            details: details.map(|d| crate::cli::redact(&d)),
            duration_ms,
            exit_code,
        };
        logger.push(entry);
    }
}

impl LogManager {
    pub fn new(log_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&log_dir);
        let manager = Self {
            log_dir,
            entries: Mutex::new(VecDeque::with_capacity(MAX_IN_MEMORY_LOGS)),
            app_handle: Mutex::new(None),
        };
        manager.cleanup_old_logs();
        manager
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        if let Ok(mut lock) = self.app_handle.lock() {
            *lock = Some(handle);
        }
    }

    pub fn log_dir(&self) -> &Path {
        &self.log_dir
    }

    pub fn push(&self, entry: LogEntry) {
        // 1. 发送前端 Tauri Event
        if let Ok(lock) = self.app_handle.lock() {
            if let Some(app) = lock.as_ref() {
                let _ = app.emit("versiondock://log-entry", &entry);
            }
        }

        // 2. 写入本地文件
        self.append_to_file(&entry);

        // 3. 存入内存环形缓冲
        if let Ok(mut entries) = self.entries.lock() {
            if entries.len() >= MAX_IN_MEMORY_LOGS {
                entries.pop_front();
            }
            entries.push_back(entry);
        }
    }

    pub fn get_entries(
        &self,
        channel: Option<LogChannel>,
        level: Option<LogLevel>,
        limit: Option<usize>,
    ) -> Vec<LogEntry> {
        let limit = limit.unwrap_or(MAX_IN_MEMORY_LOGS);
        if let Ok(entries) = self.entries.lock() {
            entries
                .iter()
                .filter(|entry| {
                    if let Some(ch) = channel {
                        if entry.channel != ch {
                            return false;
                        }
                    }
                    if let Some(lvl) = level {
                        if entry.level < lvl {
                            return false;
                        }
                    }
                    true
                })
                .rev()
                .take(limit)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        } else {
            Vec::new()
        }
    }

    pub fn clear(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
    }

    pub fn export_to_file(&self, target_path: &Path) -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(target_path)?;

        if let Ok(entries) = self.entries.lock() {
            for entry in entries.iter() {
                let line = Self::format_entry(entry);
                writeln!(file, "{}", line)?;
            }
        }
        Ok(())
    }

    fn append_to_file(&self, entry: &LogEntry) {
        let today = Local::now().format("%Y-%m-%d").to_string();
        let file_path = self.log_dir.join(format!("versiondock-{today}.log"));
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(file_path) {
            let line = Self::format_entry(entry);
            let _ = writeln!(file, "{}", line);
        }
    }

    fn format_entry(entry: &LogEntry) -> String {
        let mut line = format!(
            "[{}] [{}] [{}] {}",
            entry.timestamp,
            entry.level.as_str(),
            entry.channel.as_str(),
            entry.message
        );
        if let Some(duration) = entry.duration_ms {
            line.push_str(&format!(" (took {}ms)", duration));
        }
        if let Some(exit_code) = entry.exit_code {
            line.push_str(&format!(" (exit {})", exit_code));
        }
        if let Some(details) = &entry.details {
            line.push_str(&format!("\n{}", details));
        }
        line
    }

    fn cleanup_old_logs(&self) {
        let now = Local::now();
        if let Ok(entries) = fs::read_dir(&self.log_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with("versiondock-") && name.ends_with(".log") {
                        if let Ok(metadata) = fs::metadata(&path) {
                            if let Ok(modified) = metadata.modified() {
                                let duration = now.signed_duration_since(
                                    chrono::DateTime::<Local>::from(modified),
                                );
                                if duration.num_days() > MAX_LOG_FILE_DAYS {
                                    let _ = fs::remove_file(&path);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_respects_capacity() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = LogManager::new(temp_dir.path().to_path_buf());

        for i in 0..MAX_IN_MEMORY_LOGS + 10 {
            manager.push(LogEntry {
                id: format!("id-{}", i),
                timestamp: "2026-08-31T00:00:00Z".to_string(),
                level: LogLevel::Info,
                channel: LogChannel::Git,
                message: format!("Command {}", i),
                details: None,
                duration_ms: None,
                exit_code: Some(0),
            });
        }

        let entries = manager.get_entries(None, None, None);
        assert_eq!(entries.len(), MAX_IN_MEMORY_LOGS);
        assert_eq!(entries.first().unwrap().id, "id-10");
        assert_eq!(
            entries.last().unwrap().id,
            format!("id-{}", MAX_IN_MEMORY_LOGS + 9)
        );
    }

    #[test]
    fn filtering_by_channel_and_level_works() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = LogManager::new(temp_dir.path().to_path_buf());

        manager.push(LogEntry {
            id: "1".into(),
            timestamp: "".into(),
            level: LogLevel::Info,
            channel: LogChannel::Git,
            message: "git status".into(),
            details: None,
            duration_ms: None,
            exit_code: None,
        });

        manager.push(LogEntry {
            id: "2".into(),
            timestamp: "".into(),
            level: LogLevel::Error,
            channel: LogChannel::Svn,
            message: "svn error".into(),
            details: None,
            duration_ms: None,
            exit_code: Some(1),
        });

        let git_logs = manager.get_entries(Some(LogChannel::Git), None, None);
        assert_eq!(git_logs.len(), 1);
        assert_eq!(git_logs[0].id, "1");

        let error_logs = manager.get_entries(None, Some(LogLevel::Error), None);
        assert_eq!(error_logs.len(), 1);
        assert_eq!(error_logs[0].id, "2");
    }
}
