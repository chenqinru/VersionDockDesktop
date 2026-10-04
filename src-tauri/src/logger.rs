use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::mpsc,
    sync::{Arc, Mutex},
};

use chrono::{Local, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};

pub const MAX_IN_MEMORY_LOGS: usize = 3000;
pub const MAX_LOG_FILE_DAYS: i64 = 7;
const MAX_LOG_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_ROTATED_FILES: usize = 4;

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogContext {
    pub workspace_id: Option<String>,
    pub repository_id: Option<String>,
    pub operation_id: Option<String>,
    pub workspace_name: Option<String>,
    pub repository_name: Option<String>,
}

tokio::task_local! { static LOG_CONTEXT: LogContext; }
pub async fn with_log_context<F: std::future::Future>(context: LogContext, future: F) -> F::Output {
    LOG_CONTEXT.scope(context, future).await
}

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
    pub cwd: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub context: Option<LogContext>,
}

struct LogMemory {
    entries: Mutex<VecDeque<LogEntry>>,
    app_handle: Mutex<Option<AppHandle>>,
    storage_error: Mutex<Option<String>>,
}

enum WriteMessage {
    Entry(Box<LogEntry>),
    Flush(mpsc::Sender<Result<(), String>>),
    Relay(PathBuf),
}

pub struct LogManager {
    log_dir: PathBuf,
    memory: Arc<LogMemory>,
    writer: mpsc::SyncSender<WriteMessage>,
}

static GLOBAL_LOGGER: std::sync::OnceLock<Arc<LogManager>> = std::sync::OnceLock::new();

pub fn init_global_logger(log_dir: PathBuf) -> Arc<LogManager> {
    GLOBAL_LOGGER
        .get_or_init(|| Arc::new(LogManager::new(log_dir)))
        .clone()
}

pub fn get_logger() -> Option<Arc<LogManager>> {
    GLOBAL_LOGGER.get().cloned()
}

pub fn global_app_handle() -> Option<AppHandle> {
    GLOBAL_LOGGER.get().and_then(|mgr| {
        mgr.memory
            .app_handle
            .lock()
            .ok()
            .and_then(|lock| lock.clone())
    })
}

pub fn log_entry(
    level: LogLevel,
    channel: LogChannel,
    message: impl Into<String>,
    details: Option<String>,
    duration_ms: Option<u32>,
    exit_code: Option<i32>,
) {
    log_entry_with_cwd(
        level,
        channel,
        message,
        details,
        duration_ms,
        exit_code,
        None,
    );
}

pub fn log_entry_with_cwd(
    level: LogLevel,
    channel: LogChannel,
    message: impl Into<String>,
    details: Option<String>,
    duration_ms: Option<u32>,
    exit_code: Option<i32>,
    cwd: Option<String>,
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
            cwd,
            context: LOG_CONTEXT
                .try_with(Clone::clone)
                .ok()
                .or_else(crate::state::current_log_context),
        };
        logger.push(entry);
    }
}

impl LogManager {
    pub fn new(log_dir: PathBuf) -> Self {
        let memory = Arc::new(LogMemory {
            entries: Mutex::new(VecDeque::with_capacity(MAX_IN_MEMORY_LOGS)),
            app_handle: Mutex::new(None),
            storage_error: Mutex::new(None),
        });
        let (writer, receiver) = mpsc::sync_channel(2048);
        let target = log_dir.clone();
        let state = memory.clone();
        std::thread::Builder::new()
            .name("versiondock-log-writer".into())
            .spawn(move || write_loop(target, state, receiver))
            .expect("start log writer");
        Self {
            log_dir,
            memory,
            writer,
        }
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        if let Ok(mut lock) = self.memory.app_handle.lock() {
            *lock = Some(handle);
        }
    }

    pub fn log_dir(&self) -> &Path {
        &self.log_dir
    }

    pub fn storage_error(&self) -> Option<String> {
        self.memory
            .storage_error
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }

    pub fn set_relay_path(&self, path: PathBuf) {
        let _ = self.writer.send(WriteMessage::Relay(path));
    }

    pub fn flush(&self) -> Result<(), String> {
        let (sender, receiver) = mpsc::channel();
        self.writer
            .send(WriteMessage::Flush(sender))
            .map_err(|error| error.to_string())?;
        receiver.recv().map_err(|error| error.to_string())?
    }

    /// Worker records have already been persisted; only merge into memory and emit.
    pub fn forward(&self, mut entry: LogEntry) {
        sanitize_entry(&mut entry);
        publish(&self.memory, entry);
    }

    pub fn push(&self, mut entry: LogEntry) {
        sanitize_entry(&mut entry);
        publish(&self.memory, entry.clone());
        if self
            .writer
            .send(WriteMessage::Entry(Box::new(entry)))
            .is_err()
        {
            report_storage(&self.memory, Some("Log writer stopped".into()));
        }
    }

    pub fn get_entries(
        &self,
        channel: Option<LogChannel>,
        level: Option<LogLevel>,
        limit: Option<usize>,
    ) -> Vec<LogEntry> {
        let limit = limit.unwrap_or(MAX_IN_MEMORY_LOGS);
        if let Ok(entries) = self.memory.entries.lock() {
            let mut sorted: Vec<_> = entries
                .iter()
                .filter(|entry| {
                    channel.is_none_or(|channel| entry.channel == channel)
                        && level.is_none_or(|level| entry.level >= level)
                })
                .cloned()
                .collect();
            sorted.sort_by_cached_key(|entry| {
                (
                    chrono::DateTime::parse_from_rfc3339(&entry.timestamp)
                        .map(|time| time.timestamp_millis())
                        .unwrap_or(0),
                    entry.timestamp.clone(),
                    entry.id.clone(),
                )
            });
            sorted.split_off(sorted.len().saturating_sub(limit))
        } else {
            Vec::new()
        }
    }

    pub fn clear(&self) {
        if let Ok(mut entries) = self.memory.entries.lock() {
            entries.clear();
        }
    }

    pub fn export_to_file(&self, target_path: &Path) -> std::io::Result<()> {
        let text = format_entries(&self.get_entries(None, None, None));
        fs::write(target_path, text)
    }
}

pub fn format_entries(entries: &[LogEntry]) -> String {
    entries
        .iter()
        .map(format_entry)
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn format_entry(entry: &LogEntry) -> String {
    let mut entry = entry.clone();
    sanitize_entry(&mut entry);
    let mut line = format!(
        "[{}] [{}] [{}] {}",
        entry.timestamp,
        entry.level.as_str(),
        entry.channel.as_str(),
        entry.message.replace('\r', "\\r").replace('\n', "\\n")
    );
    if let Some(context) = &entry.context {
        for (label, value) in [
            (
                "workspace",
                context
                    .workspace_name
                    .as_ref()
                    .or(context.workspace_id.as_ref()),
            ),
            (
                "repository",
                context
                    .repository_name
                    .as_ref()
                    .or(context.repository_id.as_ref()),
            ),
            ("operation", context.operation_id.as_ref()),
        ] {
            if let Some(value) = value {
                line.push_str(&format!(
                    " [{}={}]",
                    label,
                    value.replace(['\n', '\r'], " ")
                ));
            }
        }
    }
    if let Some(cwd) = &entry.cwd {
        line.push_str(&format!(" [cwd={}]", cwd.replace(['\n', '\r'], " ")));
    }
    if let Some(duration) = entry.duration_ms {
        line.push_str(&format!(" (took {duration}ms)"));
    }
    if let Some(code) = entry.exit_code {
        line.push_str(&format!(" (exit {code})"));
    }
    if let Some(details) = &entry.details {
        if !details.trim().is_empty() {
            line.push_str(&format!("\n{}", details));
        }
    }
    line
}

fn sanitize_entry(entry: &mut LogEntry) {
    entry.message = bounded_text(&crate::cli::redact(&entry.message), 16 * 1024);
    entry.details = entry
        .details
        .take()
        .filter(|details| !details.trim().is_empty())
        .map(|details| bounded_text(&crate::cli::redact(&details), 64 * 1024));
    entry.cwd = entry.cwd.take().map(|value| crate::cli::redact(&value));
    if let Some(context) = &mut entry.context {
        for field in [
            &mut context.workspace_id,
            &mut context.repository_id,
            &mut context.operation_id,
            &mut context.workspace_name,
            &mut context.repository_name,
        ] {
            *field = field.take().map(|value| crate::cli::redact(&value));
        }
    }
}

fn bounded_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.into();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[log entry truncated]", &text[..end])
}

fn publish(memory: &LogMemory, entry: LogEntry) {
    if let Ok(mut entries) = memory.entries.lock() {
        if entries.iter().any(|existing| existing.id == entry.id) {
            return;
        }
        if entries.len() >= MAX_IN_MEMORY_LOGS {
            entries.pop_front();
        }
        entries.push_back(entry.clone());
        // Cache before emission, so initial retrieval cannot miss the emitted record.
        if let Ok(handle) = memory.app_handle.lock() {
            if let Some(app) = handle.as_ref() {
                let _ = app.emit("versiondock://log-entry", &entry);
            }
        }
    }
}

fn report_storage(memory: &LogMemory, error: Option<String>) {
    let error = error.map(|value| crate::cli::redact(&value));
    let changed = if let Ok(mut previous) = memory.storage_error.lock() {
        if *previous == error {
            false
        } else {
            *previous = error.clone();
            true
        }
    } else {
        false
    };
    if changed {
        publish(
            memory,
            LogEntry {
                id: uuid::Uuid::new_v4().to_string(),
                timestamp: Utc::now().to_rfc3339(),
                level: if error.is_some() {
                    LogLevel::Error
                } else {
                    LogLevel::Info
                },
                channel: LogChannel::Core,
                message: if error.is_some() {
                    "Log file writing failed; logs remain available in memory."
                } else {
                    "Log file writing resumed."
                }
                .into(),
                details: error,
                duration_ms: None,
                exit_code: None,
                cwd: None,
                context: None,
            },
        );
    }
}

fn write_loop(log_dir: PathBuf, memory: Arc<LogMemory>, receiver: mpsc::Receiver<WriteMessage>) {
    let mut pending = Vec::new();
    let mut relay = None;
    let mut deferred = None;
    let mut maintenance = std::time::Instant::now() - std::time::Duration::from_secs(3600);
    loop {
        let message = deferred
            .take()
            .map(Ok)
            .unwrap_or_else(|| receiver.recv_timeout(std::time::Duration::from_millis(100)));
        match message {
            Ok(WriteMessage::Entry(entry)) => pending.push(*entry),
            Ok(WriteMessage::Relay(path)) => relay = Some(path),
            Ok(WriteMessage::Flush(sender)) => {
                let had_pending = !pending.is_empty();
                let result = write_pending(&log_dir, &mut pending, relay.as_deref());
                if had_pending {
                    report_storage(
                        &memory,
                        result.as_ref().err().map(|error| error.to_string()),
                    );
                }
                let error = result.err().map(|error| error.to_string()).or_else(|| {
                    memory
                        .storage_error
                        .lock()
                        .ok()
                        .and_then(|value| value.clone())
                });
                let _ = sender.send(error.map_or(Ok(()), Err));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let result = write_pending(&log_dir, &mut pending, relay.as_deref());
                report_storage(&memory, result.err().map(|error| error.to_string()));
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if !pending.is_empty() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(5);
            while pending.len() < 64 {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match receiver.recv_timeout(remaining) {
                    Ok(WriteMessage::Entry(entry)) => pending.push(*entry),
                    Ok(other) => {
                        deferred = Some(other);
                        break;
                    }
                    Err(_) => break,
                }
            }
            let result = write_pending(&log_dir, &mut pending, relay.as_deref());
            report_storage(&memory, result.err().map(|error| error.to_string()));
        }
        if maintenance.elapsed().as_secs() >= 3600 {
            let result = cleanup_old_logs(&log_dir);
            if let Err(error) = result {
                report_storage(&memory, Some(error.to_string()));
            }
            maintenance = std::time::Instant::now();
        }
    }
}

fn write_pending(
    log_dir: &Path,
    entries: &mut Vec<LogEntry>,
    relay: Option<&Path>,
) -> std::io::Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let batch = std::mem::take(entries);
    // Forward the same IDs even if disk logging is unavailable.
    let relay_result = (|| -> std::io::Result<()> {
        if let Some(path) = relay {
            let mut file = OpenOptions::new().create(true).append(true).open(path)?;
            let text = batch
                .iter()
                .map(|entry| serde_json::to_string(entry).expect("serialize log entry"))
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            file.write_all(text.as_bytes())?;
        }
        Ok(())
    })();
    fs::create_dir_all(log_dir)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(log_dir.join(".writer.lock"))?;
    lock.lock()?;
    let result = (|| {
        let today = Local::now().format("%Y-%m-%d").to_string();
        let path = log_dir.join(format!("versiondock-{today}.log"));
        let text = format_entries(&batch) + "\n";
        if fs::metadata(&path).is_ok_and(|meta| meta.len() + text.len() as u64 > MAX_LOG_FILE_BYTES)
        {
            let _ = fs::remove_file(
                log_dir.join(format!("versiondock-{today}-{MAX_ROTATED_FILES}.log")),
            );
            for index in (1..MAX_ROTATED_FILES).rev() {
                let from = log_dir.join(format!("versiondock-{today}-{index}.log"));
                if from.exists() {
                    fs::rename(
                        from,
                        log_dir.join(format!("versiondock-{today}-{}.log", index + 1)),
                    )?;
                }
            }
            fs::rename(&path, log_dir.join(format!("versiondock-{today}-1.log")))?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        file.write_all(text.as_bytes())
    })();
    let _ = lock.unlock();
    result.and(relay_result)
}

fn cleanup_old_logs(log_dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(log_dir)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(log_dir.join(".writer.lock"))?;
    lock.lock()?;
    let result = (|| {
        for item in fs::read_dir(log_dir)? {
            let path = item?.path();
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let Some(date) = name
                .strip_prefix("versiondock-")
                .filter(|name| name.ends_with(".log"))
                .and_then(|name| name.get(..10))
                .and_then(|name| chrono::NaiveDate::parse_from_str(name, "%Y-%m-%d").ok())
            else {
                continue;
            };
            let suffix = &name["versiondock-".len() + 10..];
            let owned = suffix == ".log"
                || suffix
                    .strip_prefix('-')
                    .and_then(|value| value.strip_suffix(".log"))
                    .and_then(|value| value.parse::<usize>().ok())
                    .is_some_and(|index| (1..=MAX_ROTATED_FILES).contains(&index));
            if !owned || !path.is_file() {
                continue;
            }
            if Local::now()
                .date_naive()
                .signed_duration_since(date)
                .num_days()
                > MAX_LOG_FILE_DAYS
            {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    })();
    let _ = lock.unlock();
    result
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
                timestamp: chrono::DateTime::from_timestamp_millis(i as i64)
                    .unwrap()
                    .to_rfc3339(),
                level: LogLevel::Info,
                channel: LogChannel::Git,
                message: format!("Command {}", i),
                details: None,
                duration_ms: None,
                exit_code: Some(0),
                cwd: None,
                context: None,
            });
        }

        manager.flush().unwrap();
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
            cwd: None,
            context: None,
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
            cwd: None,
            context: None,
        });

        let git_logs = manager.get_entries(Some(LogChannel::Git), None, None);
        assert_eq!(git_logs.len(), 1);
        assert_eq!(git_logs[0].id, "1");

        let error_logs = manager.get_entries(None, Some(LogLevel::Error), None);
        assert_eq!(error_logs.len(), 1);
        assert_eq!(error_logs[0].id, "2");
    }
    fn sample(id: &str) -> LogEntry {
        LogEntry {
            id: id.into(),
            timestamp: "2026-10-04T00:00:00Z".into(),
            level: LogLevel::Info,
            channel: LogChannel::Git,
            message: format!("command-{id}"),
            details: Some(format!("details-{id}\nend-{id}")),
            duration_ms: Some(42),
            exit_code: Some(0),
            cwd: Some("/tmp/repository".into()),
            context: Some(LogContext {
                workspace_name: Some("Workspace".into()),
                repository_name: Some("Repository".into()),
                operation_id: Some(id.into()),
                ..Default::default()
            }),
        }
    }

    #[test]
    fn concurrent_writers_preserve_whole_multiline_records() {
        let root = tempfile::tempdir().unwrap();
        let managers: Vec<_> = (0..4)
            .map(|_| Arc::new(LogManager::new(root.path().into())))
            .collect();
        let threads: Vec<_> = managers
            .iter()
            .enumerate()
            .map(|(index, manager)| {
                let manager = manager.clone();
                std::thread::spawn(move || {
                    for n in 0..100 {
                        manager.push(sample(&format!("{index}-{n}")));
                    }
                    manager.flush().unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let text = fs::read_to_string(root.path().join(format!(
            "versiondock-{}.log",
            Local::now().format("%Y-%m-%d")
        )))
        .unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 1200);
        for record in lines.chunks_exact(3) {
            let id = record[1].strip_prefix("details-").unwrap();
            assert!(record[0].contains(&format!("command-{id} [workspace=Workspace]")));
            assert_eq!(record[2], format!("end-{id}"));
        }
    }

    #[test]
    #[ignore = "log writer subprocess entry"]
    fn process_writer_entry() {
        let root = std::env::var_os("VERSIONDOCK_LOG_TEST_DIR").unwrap();
        let manager = LogManager::new(root.into());
        for n in 0..100 {
            manager.push(sample(&format!("{}-{n}", std::process::id())));
        }
        manager.flush().unwrap();
    }

    #[test]
    fn separate_process_writers_share_the_file_lock() {
        let root = tempfile::tempdir().unwrap();
        let mut children: Vec<_> = (0..3)
            .map(|_| {
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--ignored",
                        "--exact",
                        "logger::tests::process_writer_entry",
                    ])
                    .env("VERSIONDOCK_LOG_TEST_DIR", root.path())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap()
            })
            .collect();
        for child in &mut children {
            assert!(child.wait().unwrap().success());
        }
        let text = fs::read_to_string(root.path().join(format!(
            "versiondock-{}.log",
            Local::now().format("%Y-%m-%d")
        )))
        .unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 900);
        for record in lines.chunks_exact(3) {
            let id = record[1].strip_prefix("details-").unwrap();
            assert!(record[0].contains(&format!("command-{id} [workspace=Workspace]")));
            assert_eq!(record[2], format!("end-{id}"));
        }
    }

    #[test]
    fn storage_failure_is_visible_and_recovery_clears_it() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("logs");
        fs::write(&path, "blocking file").unwrap();
        let manager = LogManager::new(path.clone());
        manager.push(sample("failed"));
        assert!(manager.flush().is_err());
        assert!(manager.storage_error().is_some());
        let entries = manager.get_entries(None, None, None);
        assert!(entries.iter().any(|entry| entry.id == "failed"));
        assert!(entries
            .iter()
            .any(|entry| entry.channel == LogChannel::Core && entry.level == LogLevel::Error));
        fs::remove_file(&path).unwrap();
        manager.push(sample("recovered"));
        manager.flush().unwrap();
        assert!(manager.storage_error().is_none());
        assert!(manager
            .get_entries(None, None, None)
            .iter()
            .any(|entry| entry.message == "Log file writing resumed."));
    }

    #[test]
    fn rotation_is_bounded_and_cleanup_only_deletes_owned_files() {
        let root = tempfile::tempdir().unwrap();
        let today = Local::now().format("%Y-%m-%d");
        let active = root.path().join(format!("versiondock-{today}.log"));
        for _ in 0..6 {
            fs::File::create(&active)
                .unwrap()
                .set_len(MAX_LOG_FILE_BYTES)
                .unwrap();
            write_pending(root.path(), &mut vec![sample("rotation")], None).unwrap();
        }
        for index in 1..=MAX_ROTATED_FILES {
            assert!(root
                .path()
                .join(format!("versiondock-{today}-{index}.log"))
                .exists());
        }
        assert!(!root
            .path()
            .join(format!("versiondock-{today}-5.log"))
            .exists());
        for name in [
            "versiondock-2000-01-01.log",
            "versiondock-2000-01-01-2.log",
            "versiondock-2000-01-01-notes.log",
            "other.log",
        ] {
            fs::write(root.path().join(name), "test").unwrap();
        }
        cleanup_old_logs(root.path()).unwrap();
        assert!(!root.path().join("versiondock-2000-01-01.log").exists());
        assert!(!root.path().join("versiondock-2000-01-01-2.log").exists());
        assert!(root
            .path()
            .join("versiondock-2000-01-01-notes.log")
            .exists());
        assert!(root.path().join("other.log").exists());
    }

    #[test]
    fn relay_flush_and_forward_keep_original_ids_without_double_writing() {
        let root = tempfile::tempdir().unwrap();
        let manager = LogManager::new(root.path().join("logs"));
        let relay = root.path().join("relay.jsonl");
        manager.set_relay_path(relay.clone());
        manager.push(sample("worker"));
        manager.flush().unwrap();
        let line = fs::read_to_string(relay).unwrap();
        let entry: LogEntry = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(entry.id, "worker");
        let parent = LogManager::new(root.path().join("logs"));
        parent.forward(entry.clone());
        parent.forward(entry);
        parent.flush().unwrap();
        assert_eq!(parent.get_entries(None, None, None).len(), 1);
        let file = root.path().join("logs").join(format!(
            "versiondock-{}.log",
            Local::now().format("%Y-%m-%d")
        ));
        assert_eq!(
            fs::read_to_string(file)
                .unwrap()
                .matches("command-worker")
                .count(),
            1
        );
    }

    #[test]
    fn broken_relay_does_not_prevent_disk_writes() {
        let root = tempfile::tempdir().unwrap();
        let manager = LogManager::new(root.path().join("logs"));
        manager.set_relay_path(root.path().join("missing").join("relay"));
        manager.push(sample("disk"));
        assert!(manager.flush().is_err());
        let file = root.path().join("logs").join(format!(
            "versiondock-{}.log",
            Local::now().format("%Y-%m-%d")
        ));
        assert!(fs::read_to_string(file).unwrap().contains("command-disk"));
    }

    #[test]
    fn formatting_preserves_metadata_and_redacts_secrets() {
        let mut entry = sample("format");
        entry.message = "git fetch https://user:secret@example.com/repo\nsecond line".into();
        entry.details = Some("   ".into());
        let text = format_entry(&entry);
        assert!(!text.contains("secret"));
        assert!(!text.contains('\n'));
        assert!(text.contains("\\nsecond line"));
        assert!(text.contains("[repository=Repository]"));
        assert!(text.contains("[cwd=/tmp/repository]"));
        assert!(text.contains("(took 42ms) (exit 0)"));
    }
}
