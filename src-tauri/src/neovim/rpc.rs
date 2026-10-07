//! Minimal synchronous msgpack-RPC client for `nvim --embed`.
//!
//! The client speaks Neovim's msgpack-RPC framing over the embedded child's
//! stdio using only [`rmpv`]: requests are `[0, id, method, params]`,
//! responses are `[1, id, error, result]`, notifications are
//! `[2, method, params]`. A background reader thread demultiplexes responses
//! (matched by id) from asynchronous notifications (`buf_lines_event`,
//! `redraw`, `marxen:save`, ...).
//!
//! This keeps the document actor synchronous (`std::sync`) without a Tokio
//! runtime so `cargo test` stays plain `#[test]`. Higher-level wrappers live
//! in the sibling modules; this file only frames, routes, and surfaces
//! remote errors truthfully.

use rmpv::Value;
use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_STDERR_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum RpcError {
    Io(String),
    Encode(String),
    Disconnected(String),
    Timeout(String),
    Remote(String),
    Invalid(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(detail) => write!(f, "neovim io: {detail}"),
            Self::Encode(detail) => write!(f, "neovim encode: {detail}"),
            Self::Disconnected(detail) => write!(f, "neovim disconnected: {detail}"),
            Self::Timeout(detail) => write!(f, "neovim timeout: {detail}"),
            Self::Remote(detail) => write!(f, "neovim error: {detail}"),
            Self::Invalid(detail) => write!(f, "neovim protocol: {detail}"),
        }
    }
}

impl std::error::Error for RpcError {}

#[derive(Debug, Clone)]
pub struct Notification {
    pub method: String,
    pub params: Vec<Value>,
}

struct Response {
    error: Value,
    result: Value,
}

/// Synchronous embedded-Neovim RPC session.
pub struct EmbedClient {
    writer: Arc<Mutex<BufWriter<ChildStdin>>>,
    pending: Arc<Mutex<HashMap<u32, mpsc::Sender<Response>>>>,
    notifications_tx: mpsc::Sender<Notification>,
    notifications_rx: Mutex<mpsc::Receiver<Notification>>,
    next_id: AtomicU32,
    stderr_text: Arc<Mutex<String>>,
    #[allow(dead_code)]
    child: Mutex<Child>,
}

impl EmbedClient {
    /// Spawn `nvim --embed` with the given extra argv and `VIMRUNTIME`.
    pub fn spawn(
        nvim_exe: &std::path::Path,
        vimruntime: &std::path::Path,
        extra_argv: &[String],
    ) -> Result<Self, RpcError> {
        let mut child = Command::new(nvim_exe)
            .arg("--embed")
            .args(extra_argv)
            .env("VIMRUNTIME", vimruntime)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|cause| RpcError::Io(format!("spawn {}: {cause}", nvim_exe.display())))?;

        let stdin: ChildStdin = child
            .stdin
            .take()
            .ok_or_else(|| RpcError::Io("nvim stdin unavailable".into()))?;
        let stdout: ChildStdout = child
            .stdout
            .take()
            .ok_or_else(|| RpcError::Io("nvim stdout unavailable".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| RpcError::Io("nvim stderr unavailable".into()))?;

        let writer = Arc::new(Mutex::new(BufWriter::new(stdin)));
        let pending: Arc<Mutex<HashMap<u32, mpsc::Sender<Response>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (notifications_tx, notifications_rx) = mpsc::channel();
        let stderr_text: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

        let reader_pending = Arc::clone(&pending);
        let reader_notifications = notifications_tx.clone();
        std::thread::Builder::new()
            .name("marxen-nvim-rpc".into())
            .spawn(move || {
                reader_loop(BufReader::new(stdout), reader_pending, reader_notifications);
            })
            .map_err(|cause| RpcError::Io(format!("spawn rpc reader: {cause}")))?;

        let stderr_sink = Arc::clone(&stderr_text);
        std::thread::Builder::new()
            .name("marxen-nvim-stderr".into())
            .spawn(move || {
                use std::io::Read as _;
                let mut reader = BufReader::new(stderr);
                let mut chunk = [0u8; 4096];
                loop {
                    match reader.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&chunk[..n]).into_owned();
                            if let Ok(mut guard) = stderr_sink.lock() {
                                guard.push_str(&text);
                                if guard.len() > MAX_STDERR_BYTES {
                                    let mut cut = guard.len() - MAX_STDERR_BYTES;
                                    while !guard.is_char_boundary(cut) {
                                        cut += 1;
                                    }
                                    guard.drain(..cut);
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|cause| RpcError::Io(format!("spawn stderr drain: {cause}")))?;

        Ok(Self {
            writer,
            pending,
            notifications_tx,
            notifications_rx: Mutex::new(notifications_rx),
            next_id: AtomicU32::new(1),
            stderr_text,
            child: Mutex::new(child),
        })
    }

    /// Raw RPC request. `params` must be an array-shaped Vec.
    pub fn call(&self, method: &str, params: Vec<Value>) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| RpcError::Disconnected("pending lock poisoned".into()))?
            .insert(id, tx);

        let message = Value::Array(vec![
            Value::from(0),
            Value::from(id),
            Value::from(method),
            Value::Array(params),
        ]);
        let write_result = (|| {
            let mut writer = self
                .writer
                .lock()
                .map_err(|_| RpcError::Disconnected("writer lock poisoned".into()))?;
            rmpv::encode::write_value(&mut *writer, &message)
                .map_err(|cause| RpcError::Encode(cause.to_string()))?;
            writer
                .flush()
                .map_err(|cause| RpcError::Io(cause.to_string()))?;
            Ok::<(), RpcError>(())
        })();
        if let Err(cause) = write_result {
            self.pending
                .lock()
                .ok()
                .map(|mut pending| pending.remove(&id));
            return Err(cause);
        }

        let response = rx.recv_timeout(CALL_TIMEOUT).map_err(|cause| {
            self.pending
                .lock()
                .ok()
                .map(|mut pending| pending.remove(&id));
            match cause {
                mpsc::RecvTimeoutError::Timeout => {
                    RpcError::Timeout(format!("{method} timed out after 15s"))
                }
                mpsc::RecvTimeoutError::Disconnected => {
                    RpcError::Disconnected(format!("Neovim exited while calling {method}"))
                }
            }
        })?;
        if response.error != Value::Nil {
            return Err(RpcError::Remote(format!("{method}: {}", response.error)));
        }
        Ok(response.result)
    }

    /// Fire-and-forget notification `[2, method, params]`.
    pub fn notify(&self, method: &str, params: Vec<Value>) -> Result<(), RpcError> {
        let message = Value::Array(vec![
            Value::from(2),
            Value::from(method),
            Value::Array(params),
        ]);
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| RpcError::Disconnected("writer lock poisoned".into()))?;
        rmpv::encode::write_value(&mut *writer, &message)
            .map_err(|cause| RpcError::Encode(cause.to_string()))?;
        writer
            .flush()
            .map_err(|cause| RpcError::Io(cause.to_string()))?;
        Ok(())
    }

    /// Non-blocking drain of notifications received since the last call.
    pub fn drain_notifications(&self) -> Vec<Notification> {
        let mut out = Vec::new();
        if let Ok(rx) = self.notifications_rx.lock() {
            while let Ok(item) = rx.try_recv() {
                out.push(item);
            }
        }
        out
    }

    /// Blocking wait for a notification matching `predicate`, up to `timeout`.
    /// Already-queued items are examined first; non-matching items are kept.
    pub fn wait_notification<F>(&self, timeout: Duration, mut predicate: F) -> Option<Notification>
    where
        F: FnMut(&Notification) -> bool,
    {
        let deadline = std::time::Instant::now() + timeout;
        let mut deferred = Vec::new();
        let found = loop {
            // Drain first.
            let batch: Vec<Notification> = self.drain_notifications();
            let mut hit: Option<Notification> = None;
            for item in batch {
                if hit.is_none() && predicate(&item) {
                    hit = Some(item);
                } else {
                    deferred.push(item);
                }
            }
            if hit.is_some() {
                break hit;
            }
            if std::time::Instant::now() >= deadline {
                break None;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        // Re-queue non-matching items by re-sending through the channel sender.
        for item in deferred {
            let _ = self.notifications_tx.send(item);
        }
        found
    }

    /// Kill the embedded child. Best-effort; errors are returned as strings.
    pub fn shutdown(&self) -> Result<(), RpcError> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| RpcError::Disconnected("child lock poisoned".into()))?;
        let _ = child.kill();
        let _ = child.wait();
        Ok(())
    }

    /// Stderr captured so far (config load failures surface here).
    pub fn stderr_text(&self) -> String {
        self.stderr_text
            .lock()
            .ok()
            .map(|g| g.clone())
            .unwrap_or_default()
    }
}

impl Drop for EmbedClient {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn reader_loop<R: Read + Send + 'static>(
    mut reader: BufReader<R>,
    pending: Arc<Mutex<HashMap<u32, mpsc::Sender<Response>>>>,
    notifications: mpsc::Sender<Notification>,
) {
    // Child close breaks the loop; pending callers wake via dropped senders
    // when the reader thread exits (receivers fail once senders are dropped
    // with the pending map).
    while let Ok(value) = rmpv::decode::read_value(&mut reader) {
        let array = match value {
            Value::Array(items) => items,
            _ => continue,
        };
        if array.is_empty() {
            continue;
        }
        let kind = match &array[0] {
            Value::Integer(int) => int.as_u64(),
            _ => None,
        };
        match kind {
            Some(1) => {
                // Response: [1, id, error, result].
                if array.len() != 4 {
                    continue;
                }
                let id = match &array[1] {
                    Value::Integer(int) => int.as_u64().and_then(|id| u32::try_from(id).ok()),
                    _ => None,
                };
                let Some(id) = id else { continue };
                let sender = pending
                    .lock()
                    .ok()
                    .and_then(|mut pending| pending.remove(&id));
                if let Some(sender) = sender {
                    let _ = sender.send(Response {
                        error: array[2].clone(),
                        result: array[3].clone(),
                    });
                }
            }
            Some(2) => {
                // Notification: [2, method, params].
                if array.len() != 3 {
                    continue;
                }
                let method = match &array[1] {
                    Value::String(text) => text.as_str().map(str::to_owned),
                    _ => None,
                };
                let params = match &array[2] {
                    Value::Array(items) => Some(items.clone()),
                    _ => None,
                };
                if let (Some(method), Some(params)) = (method, params) {
                    let _ = notifications.send(Notification { method, params });
                }
            }
            _ => continue,
        }
    }
    if let Ok(mut pending) = pending.lock() {
        pending.clear();
    }
}

/// Convenience: build a string param.
pub fn str_param(text: &str) -> Value {
    Value::from(text)
}

/// Convenience: build an integer param.
pub fn int_param(value: i64) -> Value {
    Value::from(value)
}
