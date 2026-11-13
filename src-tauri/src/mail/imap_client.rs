use crate::mail::error::MailError;
use crate::mail::models::{
    AccountConfig, AttachmentInfo, AttachmentPath, Contact, FolderInfo, MailDetail, MailSummary,
    MessagePage,
};
use crate::mail::net;
use crate::mail::provider::{folder_display_name, folder_kind, folder_sort_rank};
use imap::types::{Fetch, Flag, Name, NameAttribute};
use mail_parser::{Address, MessageParser, MimeHeaders};
use native_tls::{TlsConnector, TlsStream};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub type MailSession = imap::Session<MailIo>;

/// Virtual folder used by the UI for starred messages.
pub const STARRED_FOLDER: &str = "__starred__";

const SUMMARY_BYTES: u32 = 24 * 1024;
/// UIDs per UID FETCH when a page is streamed to the UI. Some servers pause for
/// seconds inside a single FETCH, so smaller batches surface rows earlier.
const SUMMARY_BATCH: usize = 6;
const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
const STARRED_PER_FOLDER: usize = 120;
const STARRED_MAX: usize = 400;

/// Protocol trace written next to the OS temp files. It only records command
/// and response lines (never message bodies beyond a line's 8KB cap) so a
/// failing login/list can be diagnosed without a debugger.
const TRACE_FILE_NAME: &str = "luma-mail-imap.log";
const TRACE_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const TRACE_MAX_LINE_BYTES: usize = 8 * 1024;
/// Raw bytes kept from the end of an overlong line so a literal marker placed
/// past the 8KB cap is still honored (otherwise the payload would be logged).
const TRACE_TAIL_BYTES: usize = 64;
const TRACE_CLIENT_PREFIX: &str = "C>";
const TRACE_SERVER_PREFIX: &str = "S>";

fn parser() -> MessageParser {
    MessageParser::default().with_minimal_headers()
}

fn trace_log_path() -> PathBuf {
    std::env::temp_dir().join(TRACE_FILE_NAME)
}

/// Appends the trace file and starts it over once it grows past 2MB. The file
/// is opened once per session; rotation is tracked locally to avoid a stat per
/// line while a large FETCH is streaming.
struct TraceLog {
    file: Option<File>,
    written: u64,
}

impl TraceLog {
    fn new() -> Self {
        let path = trace_log_path();
        if fs::metadata(&path)
            .map(|meta| meta.len() > TRACE_MAX_FILE_BYTES)
            .unwrap_or(false)
        {
            let _ = File::create(&path);
        }
        let file = OpenOptions::new().create(true).append(true).open(&path).ok();
        let written = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        Self { file, written }
    }

    fn rotate(&mut self) {
        let path = trace_log_path();
        let _ = File::create(&path);
        self.file = OpenOptions::new().create(true).append(true).open(&path).ok();
        self.written = 0;
    }

    fn write_line(&mut self, line: &str) {
        if self.file.is_none() {
            self.file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(trace_log_path())
                .ok();
        }
        if self.written > TRACE_MAX_FILE_BYTES {
            self.rotate();
        }
        if let Some(file) = self.file.as_mut() {
            let bytes = line.len() as u64 + 1;
            if writeln!(file, "{line}").is_ok() {
                self.written += bytes;
            }
        }
    }
}

/// Ends a trace line with an IMAP literal marker (`{123}` or `{123+}`) and
/// returns the payload size. Literal payloads are skipped byte-exactly instead
/// of by line because they may contain CRLF (message bodies, attachments).
fn literal_length(line: &str) -> Option<u64> {
    let close = line.trim_end().strip_suffix('}')?;
    let open = close.rfind('{')?;
    let digits = &close[open + 1..];
    let digits = digits.strip_suffix('+').unwrap_or(digits);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Splits stream bytes on CRLF and formats each complete line for the trace.
/// The first 8KB of an overlong line is kept for the log, but the last 64 raw
/// bytes are tracked separately so a literal marker sitting after the cap still
/// switches to byte-exact skipping. A skipped payload (and any CRLF inside it)
/// never reaches the log.
struct TraceLines {
    prefix: &'static str,
    line: Vec<u8>,
    tail: Vec<u8>,
    overlong: bool,
    literal_remaining: Option<u64>,
    literal_total: u64,
}

impl TraceLines {
    fn new(prefix: &'static str) -> Self {
        Self {
            prefix,
            line: Vec::new(),
            tail: Vec::new(),
            overlong: false,
            literal_remaining: None,
            literal_total: 0,
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        let mut index = 0;
        while index < chunk.len() {
            if let Some(remaining) = self.literal_remaining {
                let available = (chunk.len() - index) as u64;
                if available >= remaining {
                    index += remaining as usize;
                    self.literal_remaining = None;
                    lines.push(self.omitted_line());
                } else {
                    self.literal_remaining = Some(remaining - available);
                    index = chunk.len();
                }
                continue;
            }

            let byte = chunk[index];
            index += 1;
            if byte == b'\n' {
                if let Some((text, literal)) = self.take() {
                    lines.push(format_trace_line(self.prefix, &text));
                    if let Some(length) = literal {
                        self.literal_total = length;
                        if length == 0 {
                            lines.push(self.omitted_line());
                        } else {
                            self.literal_remaining = Some(length);
                        }
                    }
                }
                continue;
            }
            self.record_byte(byte);
        }
        lines
    }

    /// Keeps the first 8KB for the log and always the last 64 raw bytes so a
    /// literal marker after the cap is still detected.
    fn record_byte(&mut self, byte: u8) {
        if !self.overlong {
            if self.line.len() >= TRACE_MAX_LINE_BYTES {
                self.overlong = true;
            } else {
                self.line.push(byte);
            }
        }
        if self.tail.len() == TRACE_TAIL_BYTES {
            self.tail.remove(0);
        }
        self.tail.push(byte);
    }

    fn omitted_line(&self) -> String {
        format!(
            "{} [{} bytes literal omitted]",
            self.prefix, self.literal_total
        )
    }

    /// Flushes whatever is buffered when the stream ends. If the connection died
    /// inside a literal payload, the skipped bytes never reached the log; record
    /// that gap explicitly so a truncated session is not read as a clean end.
    fn flush_partial(&mut self) -> Vec<String> {
        let mut lines = Vec::new();
        if !self.line.is_empty() || self.overlong {
            if let Some((text, _)) = self.take() {
                lines.push(format_trace_line(self.prefix, &text));
            }
        }
        if self.literal_remaining.take().is_some() {
            lines.push(format!("{} [literal truncated]", self.prefix));
        }
        lines
    }

    fn take(&mut self) -> Option<(String, Option<u64>)> {
        if self.line.is_empty() && !self.overlong {
            return None;
        }
        let literal = literal_length(&String::from_utf8_lossy(&self.tail));
        if self.line.last() == Some(&b'\r') {
            self.line.pop();
        }
        let text = String::from_utf8_lossy(&self.line);
        let text = text.chars().take(TRACE_MAX_LINE_BYTES).collect::<String>();
        self.line.clear();
        self.tail.clear();
        self.overlong = false;
        Some((text, literal))
    }
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Case-insensitive `\bWORD\b` test without pulling in the regex crate.
fn contains_word(line: &str, word: &[u8]) -> bool {
    let bytes = line.as_bytes();
    bytes
        .windows(word.len())
        .enumerate()
        .any(|(index, window)| {
            window.eq_ignore_ascii_case(word)
                && (index == 0 || !is_word_byte(bytes[index - 1]))
                && (index + word.len() == bytes.len()
                    || !is_word_byte(bytes[index + word.len()]))
        })
}

fn contains_login_word(line: &str) -> bool {
    contains_word(line, b"LOGIN")
}

/// BODYSTRUCTURE appears mid-line in real FETCH responses, not only at the
/// start, so a word test is required to keep attachment names out of the log.
fn contains_bodystructure_word(line: &str) -> bool {
    contains_word(line, b"BODYSTRUCTURE")
}

fn trace_command_tag(line: &str) -> &str {
    line.trim_start().split_whitespace().next().unwrap_or("")
}

/// The LOGIN command carries the authorization code, so the whole line is
/// collapsed to its tag. Server lines are kept verbatim except BODYSTRUCTURE
/// metadata, which names attachments; any line carrying that attribute is
/// reduced to a marker so filenames and structure never reach the file.
fn format_trace_line(prefix: &str, line: &str) -> String {
    if prefix == TRACE_CLIENT_PREFIX && contains_login_word(line) {
        let tag = trace_command_tag(line);
        if tag.is_empty() || tag.eq_ignore_ascii_case("LOGIN") {
            return format!("{prefix} LOGIN [redacted]");
        }
        return format!("{prefix} {tag} LOGIN [redacted]");
    }
    if prefix == TRACE_SERVER_PREFIX && contains_bodystructure_word(line) {
        return format!("{prefix} [BODYSTRUCTURE omitted]");
    }
    format!("{prefix} {line}")
}

/// Taps an IMAP connection and records both directions into the trace file.
/// It sits outside `imap::Client` so parse failures can still be explained by
/// the exact bytes the server sent.
pub struct TraceStream<S> {
    inner: S,
    client: TraceLines,
    server: TraceLines,
    log: TraceLog,
    started: Instant,
}

/// Connection IO with tracing either on or off. Tracing is opt-in
/// (`LUMA_IMAP_TRACE=1`), so the default path cannot write session lines to
/// disk; the same build can still enable the layer to reproduce a failure.
pub enum MailIo {
    Plain(TlsStream<TcpStream>),
    Traced(TraceStream<TlsStream<TcpStream>>),
}

impl Read for MailIo {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            MailIo::Plain(inner) => inner.read(buf),
            MailIo::Traced(inner) => inner.read(buf),
        }
    }
}

impl Write for MailIo {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            MailIo::Plain(inner) => inner.write(buf),
            MailIo::Traced(inner) => inner.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            MailIo::Plain(inner) => inner.flush(),
            MailIo::Traced(inner) => inner.flush(),
        }
    }
}

/// Tracing is opt-in: only `LUMA_IMAP_TRACE=1|true|on` wraps the socket, so
/// normal sessions never write protocol lines to disk.
fn trace_enabled_value(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim),
        Some(value) if value.eq_ignore_ascii_case("1")
            || value.eq_ignore_ascii_case("true")
            || value.eq_ignore_ascii_case("on")
    )
}

fn trace_enabled() -> bool {
    trace_enabled_value(std::env::var("LUMA_IMAP_TRACE").ok().as_deref())
}

impl<S: Read + Write> TraceStream<S> {
    fn new(inner: S) -> Self {
        Self {
            inner,
            client: TraceLines::new(TRACE_CLIENT_PREFIX),
            server: TraceLines::new(TRACE_SERVER_PREFIX),
            log: TraceLog::new(),
            started: Instant::now(),
        }
    }

    fn record(&mut self, lines: Vec<String>) {
        for line in lines {
            let elapsed = self.started.elapsed().as_millis();
            self.log.write_line(&format!("[+{elapsed}ms] {line}"));
        }
    }
}

impl<S: Read + Write> Read for TraceStream<S> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf)?;
        let lines = self.server.push(&buf[..read]);
        self.record(lines);
        Ok(read)
    }
}

impl<S: Read + Write> Write for TraceStream<S> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buf)?;
        let lines = self.client.push(&buf[..written]);
        self.record(lines);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl<S> Drop for TraceStream<S> {
    fn drop(&mut self) {
        let elapsed = self.started.elapsed().as_millis();
        for line in self.client.flush_partial() {
            self.log.write_line(&format!("[+{elapsed}ms] {line}"));
        }
        for line in self.server.flush_partial() {
            self.log.write_line(&format!("[+{elapsed}ms] {line}"));
        }
    }
}

/// Classifies a TLS handshake failure. Windows reports connect timeouts with
/// localized text plus a WinSock error code, so matching only English wording
/// would mislabel a timeout as a certificate problem.
pub(crate) fn classify_handshake_text(text: &str) -> MailError {
    let lower = text.to_ascii_lowercase();
    if lower.contains("timed out")
        || lower.contains("would block")
        || lower.contains("os error 10060")
        || text.contains("超时")
        || text.contains("没有正确答复")
    {
        return MailError::timeout(Some(text.to_string()));
    }
    if lower.contains("os error 10061")
        || lower.contains("connection refused")
        || lower.contains("os error 10054")
        || lower.contains("connection reset")
        || lower.contains("os error 10053")
        || text.contains("连接被拒绝")
    {
        return MailError::network(Some(text.to_string()));
    }
    MailError::tls(Some(text.to_string()))
}

fn map_handshake(err: native_tls::HandshakeError<TcpStream>) -> MailError {
    classify_handshake_text(&err.to_string())
}

/// RFC 2971 ID payload sent after LOGIN.
const ID_COMMAND: &str =
    "ID (\"name\" \"Luma Mail\" \"version\" \"0.1.0\" \"vendor\" \"Luma\")";

/// Coremail (163/126/yeah/188) refuses `SELECT` until the client has sent
/// RFC 2971 `ID` ("Unsafe Login"). Every other provider treats `ID` as
/// optional, so only these domains get the command.
///
/// Matching is on the registrable domain itself or a subdomain of it, so
/// `imap.163.com` matches while `not163.com` and `163.com.evil.com` do not.
fn requires_id(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    const COREMAIL_DOMAINS: [&str; 4] = ["163.com", "126.com", "yeah.net", "188.com"];
    COREMAIL_DOMAINS.iter().any(|domain| {
        host == *domain || host.ends_with(&format!(".{domain}"))
    })
}

/// Runs the IMAP handshake (greeting + LOGIN) on an already-connected stream.
/// Split out so tests can replay a server transcript without TLS.
fn open_session<S: Read + Write>(
    stream: S,
    host: &str,
    username: &str,
    password: &str,
) -> Result<imap::Session<S>, MailError> {
    let client = imap::Client::new(stream);
    // `login` reads the server greeting as the first untagged line.
    let mut session = client
        .login(username, password)
        .map_err(|(e, _)| MailError::from_imap(&e))?;

    // Only Coremail needs ID; sending it elsewhere is not harmless. imap 2.4
    // parses tagged responses with imap-proto 0.10, which has no `Response::ID`
    // variant: an unparsable `* ID (...)` line aborts `read_response` and
    // leaves the server's tagged OK queued in the stream, so the *next*
    // command (typically LOGOUT) reads a stale tag and panics on the
    // `assert_eq!(tag, match_tag)` in `read_response_onto`. QQ/Exmail and
    // Gmail accept but do not require ID, so they must skip it.
    if requires_id(host) {
        // Coremail answers with a plain tagged OK and no untagged `* ID` line,
        // so the response stream stays in sync here; the result is not needed.
        let _ = session.run_command_and_read_response(ID_COMMAND);
    }

    Ok(session)
}

/// Opens an authenticated IMAP session. IMAP always uses implicit TLS; any
/// other configuration is rejected instead of silently degrading to plaintext.
pub fn connect(account: &AccountConfig, password: &str) -> Result<MailSession, MailError> {
    if !account.imap.security.eq_ignore_ascii_case("ssl") {
        return Err(MailError::tls(Some(
            "IMAP 仅支持 SSL/TLS 加密连接".to_string(),
        )));
    }

    // Goes through the system proxy's HTTP CONNECT tunnel when one applies,
    // and falls back to a direct connection when the proxy is unusable.
    let (tcp, _proxied) = net::dial(&account.imap.host, account.imap.port)?;
    let connector = TlsConnector::builder()
        .build()
        .map_err(|e| MailError::tls(Some(e.to_string())))?;
    let tls = connector
        .connect(&account.imap.host, tcp)
        .map_err(map_handshake)?;

    let io = if trace_enabled() {
        MailIo::Traced(TraceStream::new(tls))
    } else {
        MailIo::Plain(tls)
    };
    open_session(
        io,
        &account.imap.host,
        &account.username,
        password,
    )
}

pub fn close(mut session: MailSession) {
    // A command that failed to parse can leave its tagged response unread.
    // imap 2.4's `logout` then asserts the tag and panics; catching it keeps
    // the JoinError from replacing the real Parse error.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = session.logout();
    }));
}

fn attribute_text(attr: &NameAttribute<'_>) -> String {
    match attr {
        NameAttribute::NoInferiors => "\\Noinferiors".to_string(),
        NameAttribute::NoSelect => "\\Noselect".to_string(),
        NameAttribute::Marked => "\\Marked".to_string(),
        NameAttribute::Unmarked => "\\Unmarked".to_string(),
        // imap-proto 0.10 matches `\Noselect` case-sensitively, so a server
        // spelling it `\NoSelect` lands in `Custom`. Normalize it here so
        // folder_kind's special-use matching sees the same value everywhere.
        NameAttribute::Custom(value) => {
            if is_no_select_attribute(attr) {
                "\\Noselect".to_string()
            } else {
                value.to_string()
            }
        }
    }
}

/// imap 2.4.1's `NameAttribute` parser only recognizes `\Noselect` with that
/// exact casing; Exmail sends `\NoSelect`, which becomes `Custom`. Treat both
/// spellings as non-selectable, otherwise a STATUS is issued against a
/// folder that cannot be selected and its empty `* STATUS name ()` response
/// desynchronizes the session.
fn is_no_select_attribute(attr: &NameAttribute<'_>) -> bool {
    match attr {
        NameAttribute::NoSelect => true,
        NameAttribute::Custom(value) => value.eq_ignore_ascii_case("\\noselect"),
        _ => false,
    }
}

fn is_selectable(name: &Name) -> bool {
    !name.attributes().iter().any(is_no_select_attribute)
}

/// imap 2.4's `parse_mailbox` sends `* STATUS name (UNSEEN n)` through the
/// unsolicited-response channel instead of filling `Mailbox::unseen`, so the
/// returned mailbox alone always reports `None`. Drain the channel after each
/// STATUS to read the value the server actually sent.
fn take_status_unseen<S: Read + Write>(
    session: &mut imap::Session<S>,
    path: &str,
) -> Option<u32> {
    let mut unseen = None;
    while let Ok(response) = session.unsolicited_responses.try_recv() {
        if let imap::types::UnsolicitedResponse::Status { mailbox, attributes } = response {
            if mailbox == path {
                unseen = attributes.into_iter().find_map(|attribute| match attribute {
                    imap::types::StatusAttribute::Unseen(count) => Some(count),
                    _ => None,
                });
            }
        }
    }
    unseen
}

pub fn list_folders<S: Read + Write>(
    session: &mut imap::Session<S>,
) -> Result<Vec<FolderInfo>, MailError> {
    collect_folders(session, true)
}

/// Same LIST parsing and ordering as [`list_folders`], but never issues
/// STATUS. Callers that keep using the same session for SELECT/APPEND take
/// this path so a slow or unparsable STATUS cannot delay or desynchronize the
/// command that actually matters. Unread counts are always 0 here.
pub fn list_folders_basic<S: Read + Write>(
    session: &mut imap::Session<S>,
) -> Result<Vec<FolderInfo>, MailError> {
    collect_folders(session, false)
}

fn collect_folders<S: Read + Write>(
    session: &mut imap::Session<S>,
    with_status: bool,
) -> Result<Vec<FolderInfo>, MailError> {
    let names = session
        .list(None, Some("*"))
        .map_err(|e| MailError::from_imap(&e))?;

    let mut folders = Vec::new();
    // Once a STATUS response fails to parse, imap 2.4 leaves its tagged OK
    // unread; the next command would assert a stale tag and panic. Stop
    // querying unread counts but still return the folder list discovered by
    // LIST.
    let mut status_available = with_status;
    for name in names.iter() {
        if !is_selectable(name) {
            continue;
        }
        let path = name.name().to_string();
        if path.is_empty() {
            continue;
        }

        let attrs = name
            .attributes()
            .iter()
            .map(attribute_text)
            .collect::<Vec<_>>();
        let kind = folder_kind(&path, &attrs);
        let unread = if !status_available {
            0
        } else {
            let status = session.status(&path, "(UNSEEN)");
            match status {
                Ok(mailbox) => mailbox
                    .unseen
                    .or_else(|| take_status_unseen(session, &path))
                    .unwrap_or(0),
                // NO/BAD consume the tagged response, so the connection is
                // still in sync and later folders can be queried.
                Err(imap::Error::No(_)) | Err(imap::Error::Bad(_)) => 0,
                // Parse/IO/ConnectionLost leave the tagged response queued.
                Err(_) => {
                    status_available = false;
                    0
                }
            }
        };

        folders.push(FolderInfo {
            name: folder_display_name(&path, kind),
            path,
            kind: kind.to_string(),
            unread,
        });
    }

    folders.sort_by(|a, b| {
        folder_sort_rank(&a.kind)
            .cmp(&folder_sort_rank(&b.kind))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(folders)
}

pub fn folder_by_kind<'a>(folders: &'a [FolderInfo], kind: &str) -> Option<&'a FolderInfo> {
    folders.iter().find(|f| f.kind == kind)
}

fn clamp_page(page: u32, page_size: u32) -> (usize, usize) {
    let size = page_size.clamp(1, 100) as usize;
    // Pages are 1-based to match the frontend: page 1 is the newest slice.
    // page 0 is treated as page 1.
    let start = (page.max(1) as usize - 1).saturating_mul(size);
    (start, size)
}

/// Splits a page of UIDs into FETCH batches, preserving order. Ten UIDs with
/// the production size of 6 become 6/4 so the last batch is never oversized.
fn batch_uids(uids: &[u32], size: usize) -> Vec<&[u32]> {
    uids.chunks(size.max(1)).collect()
}

/// Non-streaming variant kept for callers (and protocol tests) that want the
/// whole page in one shot. The UI now uses `list_messages_streamed`.
#[allow(dead_code)]
pub fn list_messages(
    session: &mut MailSession,
    folder: &str,
    page: u32,
    page_size: u32,
) -> Result<MessagePage, MailError> {
    list_messages_with_progress(session, folder, page, page_size, |_, _| {})
}

/// Same result as `list_messages`, but the page is fetched `SUMMARY_BATCH` UIDs
/// at a time so callers can render the first rows while the server is still
/// answering the rest. Each callback receives the batch in page order plus the
/// total count of UIDs in the folder.
pub fn list_messages_with_progress<S, F>(
    session: &mut imap::Session<S>,
    folder: &str,
    page: u32,
    page_size: u32,
    mut on_batch: F,
) -> Result<MessagePage, MailError>
where
    S: Read + Write,
    F: FnMut(Vec<MailSummary>, u32),
{
    if folder == STARRED_FOLDER {
        return Err(MailError::unknown("星标邮件需要文件夹上下文".to_string()));
    }

    session
        .select(folder)
        .map_err(|e| MailError::from_imap(&e))?;

    let found = session
        .uid_search("ALL")
        .map_err(|e| MailError::from_imap(&e))?;
    let mut uids: Vec<u32> = found.into_iter().collect();
    uids.sort_unstable_by(|a, b| b.cmp(a));

    let total = uids.len() as u32;
    let (start, size) = clamp_page(page, page_size);
    if start >= uids.len() {
        return Ok(MessagePage {
            items: Vec::new(),
            total,
            has_more: false,
        });
    }

    let end = (start + size).min(uids.len());
    let page_uids = &uids[start..end];
    let mut items = Vec::with_capacity(page_uids.len());

    for batch in batch_uids(page_uids, SUMMARY_BATCH) {
        let mut summaries = fetch_summaries(session, batch, folder)?;

        // uid_fetch may return messages out of order; keep the newest-first
        // order produced by the UID sort within each batch.
        let order: HashMap<u32, usize> = batch
            .iter()
            .enumerate()
            .map(|(index, uid)| (*uid, index))
            .collect();
        summaries.sort_by_key(|item| order.get(&item.uid).copied().unwrap_or(usize::MAX));

        on_batch(summaries.clone(), total);
        items.extend(summaries);
    }

    Ok(MessagePage {
        items,
        total,
        has_more: end < uids.len(),
    })
}

fn summary_query(with_bodystructure: bool) -> String {
    if with_bodystructure {
        format!(
            "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.{SUMMARY_BYTES}> BODYSTRUCTURE)"
        )
    } else {
        format!("(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.{SUMMARY_BYTES}>)")
    }
}

/// Runs one UID FETCH and returns summaries in the requested UID order. The raw
/// `imap::Error` is kept so callers can tell whether the tagged response was
/// consumed (NO/BAD) or the session may still hold it.
fn fetch_batch<S: Read + Write>(
    session: &mut imap::Session<S>,
    uids: &[u32],
    folder: &str,
    with_bodystructure: bool,
) -> Result<Vec<MailSummary>, imap::Error> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }

    let set = uids
        .iter()
        .map(|uid| uid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let fetches = session.uid_fetch(set, summary_query(with_bodystructure))?;

    let order: HashMap<u32, usize> = uids
        .iter()
        .enumerate()
        .map(|(index, uid)| (*uid, index))
        .collect();
    let mut result: Vec<(usize, MailSummary)> = Vec::new();
    for fetch in fetches.iter() {
        let Some(uid) = fetch.uid else {
            continue;
        };
        let Some(index) = order.get(&uid).copied() else {
            continue;
        };
        if let Some((_, summary)) = summary_from_fetch(fetch, folder) {
            result.push((index, summary));
        }
    }
    result.sort_by_key(|(index, _)| *index);
    Ok(result.into_iter().map(|(_, summary)| summary).collect())
}

/// Fetches only BODYSTRUCTURE for the given UIDs. It is a separate command so a
/// structure the parser cannot read costs only the paperclip flags, never the
/// rows; the raw error lets the caller track whether the session is still in
/// sync.
fn fetch_attachment_flags<S: Read + Write>(
    session: &mut imap::Session<S>,
    uids: &[u32],
) -> Result<HashMap<u32, bool>, imap::Error> {
    if uids.is_empty() {
        return Ok(HashMap::new());
    }

    let set = uids
        .iter()
        .map(|uid| uid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let fetches = session.uid_fetch(set, "(UID BODYSTRUCTURE)")?;

    let mut flags = HashMap::new();
    for fetch in fetches.iter() {
        if let Some(uid) = fetch.uid {
            flags.insert(
                uid,
                fetch
                    .bodystructure()
                    .map(structure_has_attachment)
                    .unwrap_or(false),
            );
        }
    }
    Ok(flags)
}

fn merge_attachment_flags(summaries: &mut [MailSummary], flags: &HashMap<u32, bool>) {
    for summary in summaries.iter_mut() {
        if let Some(has_attachments) = flags.get(&summary.uid) {
            summary.has_attachments = *has_attachments;
        }
    }
}

/// Restores attachment flags for rows that came from a reduced query. Failure
/// leaves them false and marks a possibly dirty session so the next command
/// reconnects first.
fn recover_attachment_flags<S: Read + Write>(
    session: &mut imap::Session<S>,
    uids: &[u32],
    summaries: &mut [MailSummary],
    dirty: &mut bool,
) {
    match fetch_attachment_flags(session, uids) {
        Ok(flags) => merge_attachment_flags(summaries, &flags),
        Err(err) => {
            log_fetch_failure("bodystructure", uids.len(), &err);
            *dirty = !tagged_response_consumed(&err);
        }
    }
}

/// Declared literal lengths found in an unparsed response, capped so a broken
/// stream cannot flood the diagnostic line.
fn literal_marker_lengths(text: &str) -> Vec<u64> {
    let bytes = text.as_bytes();
    let mut lengths = Vec::new();
    let mut index = 0;
    while index < bytes.len() && lengths.len() < 16 {
        if bytes[index] == b'{' {
            let mut end = index + 1;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            let digits_end = end;
            if end > index + 1 && bytes.get(end) == Some(&b'+') {
                end += 1;
            }
            if digits_end > index + 1 && bytes.get(end) == Some(&b'}') {
                if let Ok(length) = text[index + 1..digits_end].parse::<u64>() {
                    lengths.push(length);
                }
                index = end + 1;
                continue;
            }
        }
        index += 1;
    }
    lengths
}

/// Shape-only description of a failed FETCH. Never records bodies, subjects,
/// senders or attachment names: only byte/line counts, token counts, literal
/// sizes and the error kind.
fn fetch_failure_shape(err: &imap::Error) -> String {
    match err {
        imap::Error::Parse(imap::error::ParseError::Invalid(bytes)) => {
            let text = String::from_utf8_lossy(bytes);
            format!(
                "bytes={} lines={} fetch_tokens={} bodystructure_tokens={} literal_lengths={:?}",
                bytes.len(),
                bytes.iter().filter(|byte| **byte == b'\n').count(),
                text.matches("FETCH").count(),
                text.matches("BODYSTRUCTURE").count(),
                literal_marker_lengths(&text),
            )
        }
        imap::Error::No(_) => "kind=no".to_string(),
        imap::Error::Bad(_) => "kind=bad".to_string(),
        imap::Error::Io(_) => "kind=io".to_string(),
        imap::Error::ConnectionLost => "kind=connection-lost".to_string(),
        _ => "kind=other".to_string(),
    }
}

fn log_fetch_failure(stage: &str, uid_count: usize, err: &imap::Error) {
    let mut log = TraceLog::new();
    log.write_line(&format!(
        "[fetch-diag] op=UID FETCH stage={stage} uids={uid_count} {}",
        fetch_failure_shape(err)
    ));
}

/// The structure follow-up would re-send the same attribute that just failed,
/// so a batch whose full query aborted on a parse error skips it instead of
/// paying another failure and reconnect.
fn log_bodystructure_skipped(uid_count: usize) {
    let mut log = TraceLog::new();
    log.write_line(&format!(
        "[fetch-diag] op=UID FETCH stage=bodystructure-skipped uids={uid_count}"
    ));
}

/// A NO/BAD reply is read and consumed by the imap client before the error is
/// returned, so the next command starts in sync. Parse/IO/ConnectionLost can
/// abort mid-response and leave the tagged line queued.
fn tagged_response_consumed(err: &imap::Error) -> bool {
    matches!(err, imap::Error::No(_) | imap::Error::Bad(_))
}

fn reopen<S: Read + Write, C: FnMut() -> Result<imap::Session<S>, MailError>>(
    session: &mut imap::Session<S>,
    reconnect: &mut C,
    folder: &str,
) -> Result<(), MailError> {
    *session = reconnect()?;
    session
        .select(folder)
        .map(|_| ())
        .map_err(|e| MailError::from_imap(&e))
}

/// Streams a page like `list_messages_with_progress`, but a batch that fails to
/// parse is retried without BODYSTRUCTURE and then one UID at a time, so a
/// single malformed message cannot take down the page. Reduced rows get their
/// attachment flags from a separate structure-only FETCH, whose failure only
/// costs the paperclip. `reconnect` must return a fresh session for the same
/// account; it is used only when a failed command may have left its tagged
/// response unread.
pub fn list_messages_streamed<S, C, F>(
    session: &mut imap::Session<S>,
    folder: &str,
    page: u32,
    page_size: u32,
    mut reconnect: C,
    mut on_batch: F,
) -> Result<MessagePage, MailError>
where
    S: Read + Write,
    C: FnMut() -> Result<imap::Session<S>, MailError>,
    F: FnMut(Vec<MailSummary>, u32),
{
    if folder == STARRED_FOLDER {
        return Err(MailError::unknown("星标邮件需要文件夹上下文".to_string()));
    }

    session
        .select(folder)
        .map_err(|e| MailError::from_imap(&e))?;

    let found = session
        .uid_search("ALL")
        .map_err(|e| MailError::from_imap(&e))?;
    let mut uids: Vec<u32> = found.into_iter().collect();
    uids.sort_unstable_by(|a, b| b.cmp(a));

    let total = uids.len() as u32;
    let (start, size) = clamp_page(page, page_size);
    if start >= uids.len() {
        return Ok(MessagePage {
            items: Vec::new(),
            total,
            has_more: false,
        });
    }

    let end = (start + size).min(uids.len());
    let page_uids = &uids[start..end];
    let mut items = Vec::with_capacity(page_uids.len());
    let mut skipped = 0usize;
    let mut dirty = false;

    for batch in batch_uids(page_uids, SUMMARY_BATCH) {
        let mut summaries = Vec::new();
        let mut resolved = false;
        let mut full_parse_failure = false;

        if dirty {
            reopen(session, &mut reconnect, folder)?;
            dirty = false;
        }
        match fetch_batch(session, batch, folder, true) {
            Ok(found) => {
                summaries = found;
                resolved = true;
            }
            Err(err) => {
                log_fetch_failure("batch-full", batch.len(), &err);
                full_parse_failure = matches!(err, imap::Error::Parse(_));
                dirty = !tagged_response_consumed(&err);
            }
        }

        if !resolved {
            if dirty {
                reopen(session, &mut reconnect, folder)?;
                dirty = false;
            }
            match fetch_batch(session, batch, folder, false) {
                Ok(found) => {
                    summaries = found;
                    resolved = true;
                    if full_parse_failure {
                        log_bodystructure_skipped(batch.len());
                    } else {
                        recover_attachment_flags(session, batch, &mut summaries, &mut dirty);
                    }
                }
                Err(err) => {
                    log_fetch_failure("batch-reduced", batch.len(), &err);
                    dirty = !tagged_response_consumed(&err);
                }
            }
        }

        if !resolved {
            for uid in batch {
                if dirty {
                    reopen(session, &mut reconnect, folder)?;
                    dirty = false;
                }
                match fetch_batch(session, &[*uid], folder, false) {
                    Ok(mut found) => {
                        recover_attachment_flags(session, &[*uid], &mut found, &mut dirty);
                        summaries.append(&mut found);
                    }
                    Err(err) => {
                        skipped += 1;
                        log_fetch_failure("single-reduced", 1, &err);
                        dirty = !tagged_response_consumed(&err);
                    }
                }
            }
        }

        on_batch(summaries.clone(), total);
        items.extend(summaries);
    }

    if skipped > 0 {
        let mut log = TraceLog::new();
        log.write_line(&format!(
            "[fetch-diag] result skipped={skipped} delivered={} total={total}",
            items.len()
        ));
        // An empty page must not look like an empty folder in the UI.
        if items.is_empty() && !page_uids.is_empty() {
            return Err(MailError::invalid(format!(
                "本页邮件加载失败（服务器响应异常，已跳过 {skipped} 封）"
            )));
        }
    }

    Ok(MessagePage {
        items,
        total,
        has_more: end < uids.len(),
    })
}

pub fn list_starred<S, C>(
    session: &mut imap::Session<S>,
    folders: &[FolderInfo],
    page: u32,
    page_size: u32,
    mut reconnect: C,
) -> Result<MessagePage, MailError>
where
    S: Read + Write,
    C: FnMut() -> Result<imap::Session<S>, MailError>,
{
    // Gmail exposes an All Mail folder which already contains every starred
    // message; searching it alone avoids duplicates. Other providers get a
    // scan over the user-facing folders.
    let has_archive = folders.iter().any(|f| f.kind == "archive");
    let scope = folders.iter().filter(|folder| {
        if has_archive {
            folder.kind == "archive"
        } else {
            matches!(folder.kind.as_str(), "inbox" | "sent" | "drafts" | "other")
        }
    });

    let mut collected: Vec<(i64, MailSummary)> = Vec::new();
    let mut dirty = false;

    for folder in scope {
        // A parse failure leaves its tagged reply queued; only a fresh session
        // can resync, and continuing on the old one would trip the tag assert.
        if dirty {
            reopen(session, &mut reconnect, &folder.path)?;
            dirty = false;
        } else if session.select(&folder.path).is_err() {
            continue;
        }
        let found = match session.uid_search("FLAGGED") {
            Ok(found) => found,
            Err(err) => {
                dirty = !tagged_response_consumed(&err);
                continue;
            }
        };
        let mut uids: Vec<u32> = found.into_iter().collect();
        uids.sort_unstable_by(|a, b| b.cmp(a));
        uids.truncate(STARRED_PER_FOLDER);
        if uids.is_empty() {
            continue;
        }

        let mut summaries = None;
        match fetch_summaries_raw(session, &uids, &folder.path, true) {
            Ok(found) => summaries = Some(found),
            Err(err) => {
                log_fetch_failure("starred-batch-full", uids.len(), &err);
                dirty = !tagged_response_consumed(&err);
            }
        }

        if summaries.is_none() {
            if dirty {
                reopen(session, &mut reconnect, &folder.path)?;
                dirty = false;
            }
            match fetch_summaries_raw(session, &uids, &folder.path, false) {
                Ok(found) => summaries = Some(found),
                Err(err) => {
                    log_fetch_failure("starred-batch-reduced", uids.len(), &err);
                    dirty = !tagged_response_consumed(&err);
                }
            }
        }

        if let Some(found) = summaries {
            collected.extend(found);
        } else {
            // One malformed structure must not abort the whole starred scan.
            let mut folder_summaries = Vec::new();
            for uid in &uids {
                if dirty {
                    reopen(session, &mut reconnect, &folder.path)?;
                    dirty = false;
                }
                match fetch_summaries_raw(session, &[*uid], &folder.path, false) {
                    Ok(mut found) => folder_summaries.append(&mut found),
                    Err(err) => {
                        log_fetch_failure("starred-single-reduced", 1, &err);
                        dirty = !tagged_response_consumed(&err);
                    }
                }
            }
            collected.extend(folder_summaries);
        }

        if collected.len() >= STARRED_MAX {
            break;
        }
    }

    collected.sort_by(|a, b| b.0.cmp(&a.0));
    collected.truncate(STARRED_MAX);

    let total = collected.len() as u32;
    let (start, size) = clamp_page(page, page_size);
    let items = collected
        .into_iter()
        .skip(start)
        .take(size)
        .map(|(_, summary)| summary)
        .collect::<Vec<_>>();

    Ok(MessagePage {
        items,
        total,
        has_more: start + size < total as usize,
    })
}

fn fetch_summaries<S: Read + Write>(
    session: &mut imap::Session<S>,
    uids: &[u32],
    folder: &str,
) -> Result<Vec<MailSummary>, MailError> {
    Ok(fetch_summaries_with_time(session, uids, folder)?
        .into_iter()
        .map(|(_, summary)| summary)
        .collect())
}

fn fetch_summaries_with_time<S: Read + Write>(
    session: &mut imap::Session<S>,
    uids: &[u32],
    folder: &str,
) -> Result<Vec<(i64, MailSummary)>, MailError> {
    fetch_summaries_raw(session, uids, folder, true)
        .map_err(|e| MailError::from_imap(&e))
}

/// Raw variant that keeps the `imap::Error` so callers can tell whether a
/// failed command consumed its tagged reply, and can retry without
/// BODYSTRUCTURE.
fn fetch_summaries_raw<S: Read + Write>(
    session: &mut imap::Session<S>,
    uids: &[u32],
    folder: &str,
    with_bodystructure: bool,
) -> Result<Vec<(i64, MailSummary)>, imap::Error> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }

    let set = uids
        .iter()
        .map(|uid| uid.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let fetches = session.uid_fetch(set, summary_query(with_bodystructure))?;

    let order: HashMap<u32, usize> = uids
        .iter()
        .enumerate()
        .map(|(index, uid)| (*uid, index))
        .collect();

    let mut result: Vec<(usize, i64, MailSummary)> = Vec::new();
    for fetch in fetches.iter() {
        let Some(uid) = fetch.uid else {
            continue;
        };
        let Some(index) = order.get(&uid).copied() else {
            continue;
        };
        if let Some((timestamp, summary)) = summary_from_fetch(fetch, folder) {
            result.push((index, timestamp, summary));
        }
    }
    result.sort_by_key(|(index, _, _)| *index);
    Ok(result
        .into_iter()
        .map(|(_, timestamp, summary)| (timestamp, summary))
        .collect())
}

fn summary_from_fetch(fetch: &Fetch, folder: &str) -> Option<(i64, MailSummary)> {
    let body = fetch.body().unwrap_or_default();
    let parsed = parser().parse(body);
    let internal = fetch
        .internal_date()
        .map(|date| (date.to_rfc3339(), date.timestamp()));
    let parsed_date = parsed
        .as_ref()
        .and_then(|m| m.date().map(|d| (d.to_rfc3339(), d.to_timestamp())));

    let (date, timestamp) = parsed_date
        .or_else(|| internal.clone())
        .unwrap_or_else(|| (String::new(), 0));

    let subject = parsed
        .as_ref()
        .and_then(|m| m.subject())
        .map(clean_header_text)
        .unwrap_or_default();

    let from = parsed
        .as_ref()
        .and_then(|m| m.from())
        .and_then(|address| contacts_from(address).into_iter().next())
        .unwrap_or(Contact {
            name: String::new(),
            email: String::new(),
        });

    let to = parsed
        .as_ref()
        .and_then(|m| m.to())
        .map(contacts_from)
        .unwrap_or_default();

    let preview = parsed
        .as_ref()
        .and_then(|m| m.body_preview(200))
        .map(|text| collapse_whitespace(&text, 220))
        .unwrap_or_default();

    let seen = fetch.flags().iter().any(|f| matches!(f, Flag::Seen));
    let flagged = fetch.flags().iter().any(|f| matches!(f, Flag::Flagged));
    let has_attachments = fetch
        .bodystructure()
        .map(structure_has_attachment)
        .unwrap_or(false);

    Some((
        timestamp,
        MailSummary {
            uid: fetch.uid.unwrap_or_default(),
            folder: folder.to_string(),
            subject,
            from,
            to,
            date,
            seen,
            flagged,
            has_attachments,
            preview,
            size: fetch.size.unwrap_or_default(),
        },
    ))
}

fn clean_header_text(value: &str) -> String {
    value
        .chars()
        .map(|c| if c == '\r' || c == '\n' || c == '\t' { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

fn collapse_whitespace(value: &str, limit: usize) -> String {
    let mut out = String::with_capacity(value.len().min(limit * 2));
    let mut last_space = false;
    for ch in value.chars() {
        let ch = if ch.is_whitespace() { ' ' } else { ch };
        if ch == ' ' {
            if last_space {
                continue;
            }
            last_space = true;
        } else {
            last_space = false;
        }
        out.push(ch);
        if out.chars().count() >= limit {
            break;
        }
    }
    out.trim().to_string()
}

fn contacts_from(address: &Address<'_>) -> Vec<Contact> {
    let mut contacts = Vec::new();
    match address {
        Address::List(list) => {
            for addr in list {
                push_contact(&mut contacts, addr);
            }
        }
        Address::Group(groups) => {
            for group in groups {
                for addr in &group.addresses {
                    push_contact(&mut contacts, addr);
                }
            }
        }
    }
    contacts
}

fn push_contact(out: &mut Vec<Contact>, addr: &mail_parser::Addr<'_>) {
    let email = addr
        .address
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    if email.is_empty() {
        return;
    }
    let name = addr
        .name
        .as_deref()
        .map(clean_header_text)
        .unwrap_or_default();
    out.push(Contact { name, email });
}

fn structure_has_attachment(structure: &imap_proto::types::BodyStructure<'_>) -> bool {
    use imap_proto::types::BodyStructure;

    match structure {
        BodyStructure::Basic { common, .. } | BodyStructure::Text { common, .. } => {
            single_part_is_attachment(common)
        }
        BodyStructure::Message {
            common, body, ..
        } => single_part_is_attachment(common) || structure_has_attachment(body),
        BodyStructure::Multipart { bodies, .. } => {
            bodies.iter().any(structure_has_attachment)
        }
    }
}

fn single_part_is_attachment(common: &imap_proto::types::BodyContentCommon<'_>) -> bool {
    if let Some(disposition) = &common.disposition {
        if disposition.ty.eq_ignore_ascii_case("attachment") {
            return true;
        }
        if let Some(params) = &disposition.params {
            if params
                .iter()
                .any(|(key, _)| key.eq_ignore_ascii_case("filename"))
            {
                return true;
            }
        }
    }

    if !common.ty.ty.eq_ignore_ascii_case("text") {
        if let Some(params) = &common.ty.params {
            if params
                .iter()
                .any(|(key, _)| key.eq_ignore_ascii_case("name"))
            {
                return true;
            }
        }
    }

    false
}

pub fn get_message(
    session: &mut MailSession,
    folder: &str,
    uid: u32,
) -> Result<MailDetail, MailError> {
    session
        .select(folder)
        .map_err(|e| MailError::from_imap(&e))?;

    let fetches = session
        .uid_fetch(
            uid.to_string(),
            "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])",
        )
        .map_err(|e| MailError::from_imap(&e))?;
    let fetch = fetches
        .first()
        .ok_or_else(|| MailError::not_found("邮件不存在或已被删除"))?;

    let body = fetch
        .body()
        .ok_or_else(|| MailError::unknown("服务器未返回邮件正文".to_string()))?;
    let parsed = parser()
        .parse(body)
        .ok_or_else(|| MailError::unknown("无法解析邮件内容".to_string()))?;

    let (_, mut summary) = summary_from_fetch(fetch, folder)
        .ok_or_else(|| MailError::unknown("无法解析邮件内容".to_string()))?;

    let cc = parsed
        .cc()
        .map(contacts_from)
        .unwrap_or_default();

    let body_html = parsed
        .body_html(0)
        .map(|value| value.into_owned())
        .unwrap_or_default();
    let body_text = parsed
        .body_text(0)
        .map(|value| value.into_owned())
        .unwrap_or_default();

    let attachments = parsed
        .attachments()
        .enumerate()
        .map(|(index, part)| AttachmentInfo {
            index: index as u32,
            name: part
                .attachment_name()
                .map(clean_header_text)
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| format!("附件 {}", index + 1)),
            mime: mime_of(part),
            size: part.contents().len() as u32,
        })
        .collect::<Vec<_>>();

    if !summary.seen {
        let _ = session.uid_store(uid.to_string(), "+FLAGS.SILENT (\\Seen)");
        summary.seen = true;
    }

    Ok(MailDetail {
        summary,
        cc,
        body_html,
        body_text,
        attachments,
    })
}

fn mime_of(part: &mail_parser::MessagePart<'_>) -> String {
    part.content_type()
        .map(|content_type| match content_type.subtype() {
            Some(subtype) if !subtype.is_empty() => {
                format!("{}/{}", content_type.c_type, subtype)
            }
            _ => content_type.c_type.to_string(),
        })
        .unwrap_or_else(|| "application/octet-stream".to_string())
}

pub fn set_flags(
    session: &mut MailSession,
    folder: &str,
    uid: u32,
    flag: &str,
    value: bool,
) -> Result<(), MailError> {
    let name = match flag {
        "seen" => "Seen",
        "flagged" => "Flagged",
        _ => return Err(MailError::unknown(format!("未知的邮件标志：{flag}"))),
    };

    session
        .select(folder)
        .map_err(|e| MailError::from_imap(&e))?;
    let op = if value {
        "+FLAGS.SILENT"
    } else {
        "-FLAGS.SILENT"
    };
    session
        .uid_store(uid.to_string(), format!("{op} (\\{name})"))
        .map_err(|e| MailError::from_imap(&e))?;
    Ok(())
}

fn quote_mailbox(name: &str) -> String {
    format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Permanently removes a single message that was just flagged `\Deleted`.
/// UID EXPUNGE (RFC 4315) is used when the server advertises UIDPLUS.
pub(crate) fn expunge_uid(session: &mut MailSession, uid: u32) -> Result<(), MailError> {
    let has_uidplus = session
        .capabilities()
        .map(|caps| caps.has_str("UIDPLUS"))
        .unwrap_or(false);

    if has_uidplus {
        session
            .uid_expunge(uid.to_string())
            .map_err(|e| MailError::from_imap(&e))?;
        return Ok(());
    }

    // QQ Mail, Exmail and some others do not implement UIDPLUS, so plain
    // EXPUNGE is the only path that can remove the message. Only run it when
    // this UID is the sole \Deleted message: a plain EXPUNGE would also purge
    // every other \Deleted message in the folder.
    let deleted = session
        .uid_search("DELETED")
        .map_err(|e| MailError::from_imap(&e))?;

    if !deleted.contains(&uid) {
        // Already gone (or the UID went stale); nothing to clean up.
        return Ok(());
    }

    if deleted.len() > 1 {
        return Err(MailError::invalid(
            "该邮件服务器不支持按邮件精确删除，且文件夹内还有其他待删除邮件，请稍后在网页版清理后重试",
        ));
    }

    session.expunge().map_err(|e| MailError::from_imap(&e))?;
    Ok(())
}

pub fn move_message(
    session: &mut MailSession,
    source: &str,
    uid: u32,
    destination: &str,
) -> Result<(), MailError> {
    if source == destination {
        return Ok(());
    }

    session
        .select(source)
        .map_err(|e| MailError::from_imap(&e))?;

    if session.uid_mv(uid.to_string(), destination).is_ok() {
        return Ok(());
    }

    // Fallback for servers without RFC 6851 MOVE support. uid_copy does not
    // quote the mailbox name, so run the raw command with our own quoting.
    session
        .run_command_and_check_ok(format!("UID COPY {uid} {}", quote_mailbox(destination)))
        .map_err(|e| MailError::from_imap(&e))?;
    session
        .uid_store(uid.to_string(), "+FLAGS.SILENT (\\Deleted)")
        .map_err(|e| MailError::from_imap(&e))?;
    // The copy already succeeded; clean the source with a UID-aware expunge
    // where possible.
    expunge_uid(session, uid)?;
    Ok(())
}

pub fn delete_message(
    session: &mut MailSession,
    folders: &[FolderInfo],
    folder: &str,
    uid: u32,
    permanent: bool,
) -> Result<(), MailError> {
    let current_kind = folders
        .iter()
        .find(|f| f.path == folder)
        .map(|f| f.kind.as_str())
        .unwrap_or("other");

    if !permanent {
        if current_kind == "trash" {
            // Deleting inside the trash folder means emptying it: permanent.
        } else if let Some(trash) = folder_by_kind(folders, "trash") {
            if trash.path != folder {
                return move_message(session, folder, uid, &trash.path);
            }
        } else {
            // Never fall back to a permanent delete without explicit consent.
            return Err(MailError::delete_needs_confirm());
        }
    }

    session
        .select(folder)
        .map_err(|e| MailError::from_imap(&e))?;
    session
        .uid_store(uid.to_string(), "+FLAGS.SILENT (\\Deleted)")
        .map_err(|e| MailError::from_imap(&e))?;
    // UID EXPUNGE limits the removal to this message where supported; servers
    // without UIDPLUS (QQ/Exmail) fall back to EXPUNGE inside expunge_uid.
    expunge_uid(session, uid)?;
    Ok(())
}

pub fn append_sent(
    session: &mut MailSession,
    folders: &[FolderInfo],
    raw: &[u8],
) -> Result<bool, MailError> {
    let Some(sent) = folder_by_kind(folders, "sent") else {
        return Ok(false);
    };
    session
        .append_with_flags(&sent.path, raw, &[Flag::Seen])
        .map_err(|e| MailError::from_imap(&e))?;
    Ok(true)
}

fn sanitize_file_name(name: &str, fallback: &str) -> String {
    let cleaned = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();

    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned.chars().take(180).collect()
    }
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("attachment");
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");

    for index in 1..200 {
        let candidate = if ext.is_empty() {
            dir.join(format!("{stem} ({index})"))
        } else {
            dir.join(format!("{stem} ({index}).{ext}"))
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(name)
}

pub fn save_attachment(
    session: &mut MailSession,
    folder: &str,
    uid: u32,
    index: u32,
    destination_dir: &Path,
) -> Result<AttachmentPath, MailError> {
    session
        .select(folder)
        .map_err(|e| MailError::from_imap(&e))?;
    let fetches = session
        .uid_fetch(uid.to_string(), "(BODY.PEEK[])")
        .map_err(|e| MailError::from_imap(&e))?;
    let fetch = fetches
        .first()
        .ok_or_else(|| MailError::not_found("邮件不存在或已被删除"))?;
    let body = fetch
        .body()
        .ok_or_else(|| MailError::unknown("服务器未返回邮件内容".to_string()))?;
    let parsed = parser()
        .parse(body)
        .ok_or_else(|| MailError::unknown("无法解析邮件内容".to_string()))?;

    let part = parsed
        .attachments()
        .nth(index as usize)
        .ok_or_else(|| MailError::not_found("附件不存在"))?;

    let contents = part.contents();
    if contents.len() > MAX_ATTACHMENT_BYTES {
        return Err(MailError::too_large("附件超过 25MB，暂不支持保存"));
    }
    if contents.is_empty() {
        return Err(MailError::unknown("附件内容为空".to_string()));
    }

    let fallback = format!("附件-{uid}-{}", index + 1);
    let name = sanitize_file_name(
        part.attachment_name().unwrap_or(&fallback),
        &fallback,
    );

    fs::create_dir_all(destination_dir)
        .map_err(|e| MailError::unknown(format!("无法创建下载目录：{e}")))?;
    let path = unique_path(destination_dir, &name);
    fs::write(&path, contents)
        .map_err(|e| MailError::unknown(format!("无法保存附件：{e}")))?;

    Ok(AttachmentPath {
        name,
        path: path.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::error::MailErrorCode;
    use crate::mail::models::ServerConfig;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn gmail_account() -> AccountConfig {
        AccountConfig {
            id: "test-gmail".into(),
            provider: "gmail".into(),
            email: "luma.test.invalid@gmail.com".into(),
            display_name: "Luma".into(),
            imap: ServerConfig {
                host: "imap.gmail.com".into(),
                port: 993,
                security: "ssl".into(),
            },
            smtp: ServerConfig {
                host: "smtp.gmail.com".into(),
                port: 587,
                security: "starttls".into(),
            },
            username: "luma.test.invalid@gmail.com".into(),
        }
    }

    fn qq_account() -> AccountConfig {
        AccountConfig {
            id: "test-qq".into(),
            provider: "qq".into(),
            email: "luma.test.invalid@qq.com".into(),
            display_name: "Luma".into(),
            imap: ServerConfig {
                host: "imap.qq.com".into(),
                port: 993,
                security: "ssl".into(),
            },
            smtp: ServerConfig {
                host: "smtp.qq.com".into(),
                port: 465,
                security: "ssl".into(),
            },
            username: "luma.test.invalid@qq.com".into(),
        }
    }

    #[test]
    #[ignore = "requires network access to imap.gmail.com:993"]
    fn gmail_wrong_password_maps_to_auth_failed() {
        let err = connect(&gmail_account(), "definitely-wrong-password")
            .err()
            .expect("login must fail");
        assert_eq!(err.code, MailErrorCode::AuthFailed, "detail: {:?}", err);
        assert!(err.message.contains("不正确"), "detail: {:?}", err);
    }

    #[test]
    #[ignore = "requires network access to imap.qq.com:993"]
    fn qq_wrong_password_maps_to_auth_failed() {
        let err = connect(&qq_account(), "definitely-wrong-password")
            .err()
            .expect("login must fail");
        assert_eq!(err.code, MailErrorCode::AuthFailed, "detail: {:?}", err);
        assert!(err.message.contains("不正确"), "detail: {:?}", err);
    }

    #[test]
    fn coremail_domains_require_id() {
        for host in [
            "163.com",
            "126.com",
            "yeah.net",
            "188.com",
            "imap.163.com",
            " IMAP.126.COM. ",
            "mail.yeah.net",
            "smtp.188.com",
        ] {
            assert!(requires_id(host), "{host} should require ID");
        }
    }

    #[test]
    fn non_coremail_hosts_skip_id() {
        for host in [
            "imap.exmail.qq.com",
            "imap.qq.com",
            "imap.gmail.com",
            "not163.com",
            "163.com.evil.com",
            "163.com.cn",
            "mail.example.com",
            "",
        ] {
            assert!(!requires_id(host), "{host} must not require ID");
        }
    }

    /// Replays a canned server transcript and records every byte the client
    /// writes, so command order and tag sync can be asserted without a socket.
    struct MockStream {
        server: &'static [u8],
        pos: usize,
        written: Rc<RefCell<Vec<u8>>>,
    }

    impl Read for MockStream {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let rest = &self.server[self.pos..];
            if rest.is_empty() {
                return Ok(0);
            }
            let len = rest.len().min(buf.len());
            buf[..len].copy_from_slice(&rest[..len]);
            self.pos += len;
            Ok(len)
        }
    }

    impl Write for MockStream {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.written.borrow_mut().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn exmail_login_skips_id_and_logout_stays_in_sync() {
        // Exmail's greeting advertises ID, but the command is optional there.
        // With ID sent, imap 2.4 leaves the ID's tagged OK unread and LOGOUT
        // panics on a tag mismatch (a2 vs a3).
        const EXMAIL: &[u8] = concat!(
            "* OK [CAPABILITY IMAP4 IMAP4rev1 ID MOVE] QQMail IMAP4Server ready\r\n",
            "a1 OK LOGIN completed\r\n",
            "* BYE QQMail IMAP4Server logging out\r\n",
            "a2 OK LOGOUT completed\r\n",
        )
        .as_bytes();

        let written = Rc::new(RefCell::new(Vec::new()));
        let stream = MockStream {
            server: EXMAIL,
            pos: 0,
            written: Rc::clone(&written),
        };

        let mut session = open_session(
            stream,
            "imap.exmail.qq.com",
            "luma.test.invalid@exmail.qq.com",
            "secret",
        )
        .expect("login against the replayed transcript must succeed");
        // The old code panicked here: LOGOUT read the leftover `a2 OK` from ID.
        session.logout().expect("logout must stay in sync");

        let commands = String::from_utf8(written.borrow().clone()).expect("commands are ASCII");
        assert!(commands.contains("a1 LOGIN"), "commands: {commands}");
        assert!(commands.contains("a2 LOGOUT"), "commands: {commands}");
        assert!(
            !commands.contains(" ID "),
            "Exmail must not receive an ID command: {commands}"
        );
    }

    fn open_mock_session(
        server: &'static [u8],
    ) -> (imap::Session<MockStream>, Rc<RefCell<Vec<u8>>>) {
        let written = Rc::new(RefCell::new(Vec::new()));
        let stream = MockStream {
            server,
            pos: 0,
            written: Rc::clone(&written),
        };
        let session = open_session(
            stream,
            "imap.exmail.qq.com",
            "luma.test.invalid@exmail.qq.com",
            "secret",
        )
        .expect("login must succeed against the replayed transcript");
        (session, written)
    }

    fn written_commands(written: &Rc<RefCell<Vec<u8>>>) -> Vec<String> {
        let raw = String::from_utf8(written.borrow().clone()).expect("commands are ASCII");
        raw.lines().map(|line| line.to_string()).collect()
    }

    #[test]
    fn noselect_attribute_is_matched_case_insensitively() {
        use std::borrow::Cow;
        assert!(is_no_select_attribute(&NameAttribute::NoSelect));
        assert!(is_no_select_attribute(&NameAttribute::Custom(
            Cow::Borrowed("\\NoSelect")
        )));
        assert!(is_no_select_attribute(&NameAttribute::Custom(
            Cow::Borrowed("\\Noselect")
        )));
        assert!(!is_no_select_attribute(&NameAttribute::Custom(
            Cow::Borrowed("\\HasChildren")
        )));
        // Normalized so folder_kind sees the canonical spelling.
        assert_eq!(
            attribute_text(&NameAttribute::Custom(Cow::Borrowed("\\NoSelect"))),
            "\\Noselect"
        );
    }

    #[test]
    fn exmail_noselect_status_empty_does_not_desync() {
        // Real Exmail transcript: the \NoSelect parent used to receive a
        // STATUS whose empty `()` reply failed to parse, leaving `a3 OK`
        // queued so the next STATUS panicked on the tag assertion.
        const EXMAIL: &[u8] = concat!(
            "* OK [CAPABILITY IMAP4 IMAP4rev1 ID AUTH=PLAIN AUTH=LOGIN NAMESPACE] QQMail IMAP4Server ready\r\n",
            "a1 OK Success login ok\r\n",
            "* LIST (\\NoSelect \\HasChildren) \"/\" \"&UXZO1mWHTvZZOQ-\"\r\n",
            "* LIST (\\HasNoChildren) \"/\" \"Junk\"\r\n",
            "* LIST (\\HasNoChildren) \"/\" \"INBOX\"\r\n",
            "a2 OK LIST completed\r\n",
            "* STATUS Junk (UNSEEN 3)\r\n",
            "a3 OK STATUS completed\r\n",
            "* STATUS INBOX (UNSEEN 7)\r\n",
            "a4 OK STATUS completed\r\n",
        )
        .as_bytes();

        let (mut session, written) = open_mock_session(EXMAIL);
        let folders =
            list_folders(&mut session).expect("list_folders must survive the empty STATUS reply");

        let commands = written_commands(&written);
        assert_eq!(commands.len(), 4, "commands: {commands:?}");
        let tags = commands
            .iter()
            .map(|command| command.split_whitespace().next().unwrap_or(""))
            .collect::<Vec<_>>();
        assert_eq!(tags, vec!["a1", "a2", "a3", "a4"], "commands: {commands:?}");
        assert!(
            commands[2].starts_with("a3 STATUS \"Junk\""),
            "commands: {commands:?}"
        );
        assert!(
            commands[3].starts_with("a4 STATUS \"INBOX\""),
            "commands: {commands:?}"
        );

        let all = commands.join("\n");
        assert!(
            !all.contains("&UXZO1mWHTvZZOQ-"),
            "the \\NoSelect parent must not receive STATUS: {all}"
        );
        assert!(folders.iter().all(|f| f.path != "&UXZO1mWHTvZZOQ-"));
        let inbox = folders
            .iter()
            .find(|f| f.path == "INBOX")
            .expect("INBOX must be listed");
        assert_eq!(
            inbox.unread, 7,
            "folders: {folders:?}; commands: {commands:?}"
        );
        assert_eq!(inbox.kind, "inbox");
    }

    #[test]
    fn empty_status_stops_further_status_commands() {
        // The first STATUS reply is unparsable and leaves its tagged OK
        // queued; a second STATUS would read the stale tag and panic.
        const TRANSCRIPT: &[u8] = concat!(
            "* OK IMAP4rev1 ready\r\n",
            "a1 OK Success login ok\r\n",
            "* LIST (\\HasNoChildren) \"/\" \"Alpha\"\r\n",
            "* LIST (\\HasNoChildren) \"/\" \"Beta\"\r\n",
            "a2 OK LIST completed\r\n",
            "* STATUS Alpha ()\r\n",
            "a3 OK STATUS completed\r\n",
        )
        .as_bytes();

        let (mut session, written) = open_mock_session(TRANSCRIPT);
        let folders = list_folders(&mut session)
            .expect("a parse failure must not abort the folder list");

        let commands = written_commands(&written);
        assert_eq!(commands.len(), 3, "commands: {commands:?}");
        assert!(
            commands[2].starts_with("a3 STATUS \"Alpha\""),
            "commands: {commands:?}"
        );
        assert!(
            commands.iter().all(|command| !command.contains("Beta")),
            "no STATUS may run after a parse error: {commands:?}"
        );

        assert_eq!(folders.len(), 2);
        assert!(folders.iter().all(|f| f.unread == 0));
        let paths = folders
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&"Alpha") && paths.contains(&"Beta"), "{paths:?}");
    }

    #[test]
    fn list_folders_basic_never_sends_status() {
        const TRANSCRIPT: &[u8] = concat!(
            "* OK IMAP4rev1 ready\r\n",
            "a1 OK Success login ok\r\n",
            "* LIST (\\HasNoChildren) \"/\" \"INBOX\"\r\n",
            "a2 OK LIST completed\r\n",
        )
        .as_bytes();

        let (mut session, written) = open_mock_session(TRANSCRIPT);
        let folders = list_folders_basic(&mut session).expect("basic listing must succeed");

        let commands = written_commands(&written);
        assert_eq!(commands.len(), 2, "commands: {commands:?}");
        assert!(commands[0].starts_with("a1 LOGIN"), "commands: {commands:?}");
        assert!(commands[1].starts_with("a2 LIST"), "commands: {commands:?}");
        assert!(
            commands.iter().all(|command| !command.contains("STATUS")),
            "basic listing must not query STATUS: {commands:?}"
        );
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].path, "INBOX");
        assert_eq!(folders[0].unread, 0);
    }

    #[test]
    fn trace_redacts_login_commands() {
        let mut lines = TraceLines::new(TRACE_CLIENT_PREFIX);
        let out = lines.push(b"a7 LOGIN \"luma@example.com\" \"app-password\"\r\n");
        assert_eq!(out, vec!["C> a7 LOGIN [redacted]".to_string()]);
        assert!(!out[0].contains("app-password"));
        assert!(!out[0].contains("luma@example.com"));

        // The command name is matched case-insensitively, as servers do.
        let out = lines.push(b"a8 login user pass\r\n");
        assert_eq!(out, vec!["C> a8 LOGIN [redacted]".to_string()]);

        // A tag-less LOGIN must still be redacted.
        let out = lines.push(b"LOGIN \"user\" \"secret\"\r\n");
        assert_eq!(out, vec!["C> LOGIN [redacted]".to_string()]);
    }

    #[test]
    fn trace_keeps_commands_without_login_word() {
        let mut lines = TraceLines::new(TRACE_CLIENT_PREFIX);
        let out = lines.push(b"a1 LIST \"\" \"*\"\r\n");
        assert_eq!(out, vec!["C> a1 LIST \"\" \"*\"".to_string()]);

        // "XLOGIN" is not the LOGIN command and must not be collapsed.
        let out = lines.push(b"a2 XLOGIN foo\r\n");
        assert_eq!(out, vec!["C> a2 XLOGIN foo".to_string()]);

        let mut server = TraceLines::new(TRACE_SERVER_PREFIX);
        let out = server.push(b"* OK IMAP4rev1 ready\r\n");
        assert_eq!(out, vec!["S> * OK IMAP4rev1 ready".to_string()]);
    }

    #[test]
    fn trace_splits_chunks_at_line_boundaries() {
        let mut lines = TraceLines::new(TRACE_SERVER_PREFIX);
        assert!(lines.push(b"* OK hel").is_empty());
        let out = lines.push(b"lo\r\n* 1 EXISTS\r\n");
        assert_eq!(
            out,
            vec![
                "S> * OK hello".to_string(),
                "S> * 1 EXISTS".to_string(),
            ]
        );
    }

    #[test]
    fn trace_caps_overlong_lines_at_8kb() {
        let mut lines = TraceLines::new(TRACE_SERVER_PREFIX);
        let long = vec![b'a'; TRACE_MAX_LINE_BYTES + 500];
        assert!(lines.push(&long).is_empty());
        let out = lines.push(b"\r\n");
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0].len(),
            TRACE_SERVER_PREFIX.len() + 1 + TRACE_MAX_LINE_BYTES
        );
    }

    #[test]
    fn trace_skips_server_literal_across_chunks() {
        let mut lines = TraceLines::new(TRACE_SERVER_PREFIX);
        let out = lines.push(b"* 1 FETCH (BODY[] {10}\r\n");
        assert_eq!(out, vec!["S> * 1 FETCH (BODY[] {10}".to_string()]);

        // Eight payload bytes, including CRLF that must not split a log line.
        let out = lines.push(b"abc\r\ndef");
        assert!(out.is_empty(), "payload must not be logged: {out:?}");

        // The remaining two bytes complete the literal; the omission line
        // reports the declared length, not the chunk size.
        let out = lines.push(b"gh");
        assert_eq!(out, vec!["S> [10 bytes literal omitted]".to_string()]);

        // The response that owns the literal continues right after the payload.
        let out = lines.push(b")\r\na4 OK UID FETCH completed\r\n");
        assert_eq!(
            out,
            vec![
                "S> )".to_string(),
                "S> a4 OK UID FETCH completed".to_string(),
            ]
        );
    }

    #[test]
    fn trace_skips_client_append_literal() {
        let mut lines = TraceLines::new(TRACE_CLIENT_PREFIX);
        let out = lines.push(b"a9 APPEND \"Sent\" (\\Seen) {4}\r\n");
        assert_eq!(out, vec!["C> a9 APPEND \"Sent\" (\\Seen) {4}".to_string()]);

        // The payload itself contains CRLF; it must be discarded byte-exactly.
        let out = lines.push(b"ab\r\n");
        assert_eq!(out, vec!["C> [4 bytes literal omitted]".to_string()]);

        let out = lines.push(b"a9 OK APPEND completed\r\n");
        assert_eq!(out, vec!["C> a9 OK APPEND completed".to_string()]);
    }

    #[test]
    fn trace_detects_literal_markers_only_at_line_end() {
        assert_eq!(literal_length("* 1 FETCH (BODY[] {24578}"), Some(24578));
        assert_eq!(literal_length("a9 APPEND \"Sent\" {4+}"), Some(4));
        assert_eq!(literal_length("a1 NOOP"), None);
        assert_eq!(literal_length("a1 SELECT \"{3}\""), None);
        assert_eq!(literal_length("a1 SELECT {x}"), None);
    }

    #[test]
    fn trace_detects_literal_marker_past_the_line_cap() {
        let mut lines = TraceLines::new(TRACE_SERVER_PREFIX);
        let mut overlong = vec![b'a'; TRACE_MAX_LINE_BYTES + 500];
        overlong.extend_from_slice(b"{12}\r\n");
        let out = lines.push(&overlong);
        assert_eq!(out.len(), 1, "only the capped header line is logged: {out:?}");
        assert_eq!(
            out[0].len(),
            TRACE_SERVER_PREFIX.len() + 1 + TRACE_MAX_LINE_BYTES
        );

        // 12 payload bytes including CRLF, split across chunks like a socket.
        let out = lines.push(b"abc\r\ndef");
        assert!(out.is_empty(), "payload must not be logged: {out:?}");
        let out = lines.push(b"ghij");
        assert_eq!(out, vec!["S> [12 bytes literal omitted]".to_string()]);

        // The completion line after the skipped payload is kept.
        let out = lines.push(b") FLAGS (\\Seen)\r\n");
        assert_eq!(out, vec!["S> ) FLAGS (\\Seen)".to_string()]);
    }

    #[test]
    fn trace_omits_body_structure_metadata() {
        let mut server = TraceLines::new(TRACE_SERVER_PREFIX);
        let out =
            server.push(b"BODYSTRUCTURE (\"APPLICATION\" \"PDF\" (\"NAME\" \"invoice.pdf\"))\r\n");
        assert_eq!(out, vec!["S> [BODYSTRUCTURE omitted]".to_string()]);
        assert!(!out[0].contains("invoice.pdf"));

        // Leading whitespace is tolerated; other server lines stay verbatim.
        let out = server.push(b"  BODYSTRUCTURE (\"IMAGE\" \"PNG\")\r\n");
        assert_eq!(out, vec!["S> [BODYSTRUCTURE omitted]".to_string()]);

        // Real responses carry the attribute mid-line, after UID and before
        // the attachment parameters.
        let out = server.push(
            b"* 1 FETCH (UID 21 BODYSTRUCTURE (\"APPLICATION\" \"PDF\" (\"NAME\" \"invoice.pdf\") NIL NIL \"BASE64\" 10))\r\n",
        );
        assert_eq!(out, vec!["S> [BODYSTRUCTURE omitted]".to_string()]);
        assert!(!out[0].contains("invoice.pdf"));

        // Case-insensitive, and only a standalone word counts.
        let out = server.push(b"* 2 FETCH (UID 22 bodystructure (\"IMAGE\" \"PNG\"))\r\n");
        assert_eq!(out, vec!["S> [BODYSTRUCTURE omitted]".to_string()]);
        let out = server.push(b"* 3 FETCH (UID 23 XBODYSTRUCTURES (\"a\" \"b\"))\r\n");
        assert!(
            out[0].contains("XBODYSTRUCTURES"),
            "a longer word must not trigger the mask: {out:?}"
        );

        let out = server.push(b"* 1 FETCH (FLAGS (\\Seen))\r\n");
        assert_eq!(out, vec!["S> * 1 FETCH (FLAGS (\\Seen))".to_string()]);
    }

    #[test]
    fn trace_flags_literal_truncated_on_disconnect() {
        let mut lines = TraceLines::new(TRACE_SERVER_PREFIX);
        let out = lines.push(b"* 1 FETCH (BODY[] {100}\r\n");
        assert_eq!(out, vec!["S> * 1 FETCH (BODY[] {100}".to_string()]);

        // Only part of the payload arrives before the connection dies.
        let out = lines.push(b"secret body");
        assert!(out.is_empty(), "payload must not be logged: {out:?}");

        let flushed = lines.flush_partial();
        assert_eq!(flushed, vec!["S> [literal truncated]".to_string()]);
        assert!(!flushed.iter().any(|line| line.contains("secret")));

        // A second flush must not repeat the marker.
        assert!(lines.flush_partial().is_empty());
    }

    #[test]
    fn file_names_are_sanitized() {
        assert_eq!(sanitize_file_name("a/b:c.pdf", "x"), "a_b_c.pdf");
        assert_eq!(sanitize_file_name("..", "fallback"), "fallback");
        assert_eq!(sanitize_file_name("", "fallback"), "fallback");
    }

    #[test]
    fn pages_are_one_based() {
        assert_eq!(clamp_page(1, 30), (0, 30));
        assert_eq!(clamp_page(2, 30), (30, 30));
        assert_eq!(clamp_page(3, 30), (60, 30));
        // page 0 is coerced to the first page instead of skipping a slice.
        assert_eq!(clamp_page(0, 30), (0, 30));
        assert_eq!(clamp_page(1, 0), (0, 1));
        assert_eq!(clamp_page(1, 500), (0, 100));
    }

    #[test]
    fn batch_uids_splits_pages_in_order() {
        let uids: Vec<u32> = (1..=10).collect();

        // The helper honors the requested size: 10 with 4 is 4/4/2.
        let batches = batch_uids(&uids, 4);
        let sizes = batches.iter().map(|batch| batch.len()).collect::<Vec<_>>();
        assert_eq!(sizes, vec![4, 4, 2]);
        assert_eq!(batches[0], &[1, 2, 3, 4]);
        assert_eq!(batches[2], &[9, 10]);

        // The production batch size streams 10 uids as 6/4.
        let sizes = batch_uids(&uids, SUMMARY_BATCH)
            .iter()
            .map(|batch| batch.len())
            .collect::<Vec<_>>();
        assert_eq!(sizes, vec![6, 4]);

        assert!(batch_uids(&[], SUMMARY_BATCH).is_empty());
    }

    #[test]
    fn list_messages_with_progress_reports_one_batch_for_two_messages() {
        // Two messages in one page, each with a 21-byte BODY[] literal.
        const TRANSCRIPT: &[u8] = concat!(
            "* OK [CAPABILITY IMAP4 IMAP4rev1] ready\r\n",
            "a1 OK LOGIN completed\r\n",
            "* FLAGS (\\Seen)\r\n",
            "* 2 EXISTS\r\n",
            "* OK [UIDVALIDITY 1] UIDs valid\r\n",
            "a2 OK [READ-WRITE] SELECT completed\r\n",
            "* SEARCH 10 9\r\n",
            "a3 OK SEARCH completed\r\n",
            "* 1 FETCH (UID 10 FLAGS (\\Seen) INTERNALDATE \"01-Jan-2024 00:00:00 +0000\" RFC822.SIZE 21 BODY[] {21}\r\n",
            "Subject: One\r\n\r\nhello)\r\n",
            "* 2 FETCH (UID 9 FLAGS (\\Seen) INTERNALDATE \"02-Jan-2024 00:00:00 +0000\" RFC822.SIZE 21 BODY[] {21}\r\n",
            "Subject: Two\r\n\r\nworld)\r\n",
            "a4 OK FETCH completed\r\n",
        )
        .as_bytes();

        let (mut session, written) = open_mock_session(TRANSCRIPT);
        let mut batches: Vec<(Vec<u32>, u32)> = Vec::new();
        let page = list_messages_with_progress(&mut session, "INBOX", 1, 30, |items, total| {
            batches.push((items.iter().map(|item| item.uid).collect(), total));
        })
        .expect("streamed fetch must succeed");

        assert_eq!(batches, vec![(vec![10, 9], 2)], "one batch for two uids");
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.total, 2);
        assert!(!page.has_more);
        assert_eq!(page.items[0].uid, 10);
        assert_eq!(page.items[0].subject, "One");
        assert_eq!(page.items[1].uid, 9);

        let commands = written_commands(&written);
        assert!(
            commands.iter().any(|command| command.contains("UID FETCH")),
            "commands: {commands:?}"
        );
    }

    #[test]
    fn trace_switch_defaults_off_and_needs_explicit_on() {
        assert!(!trace_enabled_value(None));
        assert!(!trace_enabled_value(Some("")));
        assert!(!trace_enabled_value(Some("0")));
        assert!(!trace_enabled_value(Some(" false ")));
        assert!(!trace_enabled_value(Some("OFF")));
        assert!(trace_enabled_value(Some("1")));
        assert!(trace_enabled_value(Some(" TRUE ")));
        assert!(trace_enabled_value(Some("On")));
    }

    #[test]
    fn batch_failure_retries_reduced_query_and_keeps_order() {
        use std::collections::VecDeque;

        // First session: SELECT + SEARCH succeed, the batch FETCH stops on a
        // malformed FETCH line (no tagged reply is read, so it is "dirty").
        const BROKEN: &[u8] = concat!(
            "* OK [CAPABILITY IMAP4 IMAP4rev1] ready\r\n",
            "a1 OK LOGIN completed\r\n",
            "* FLAGS (\\Seen)\r\n",
            "* 2 EXISTS\r\n",
            "* OK [UIDVALIDITY 1] UIDs valid\r\n",
            "a2 OK [READ-WRITE] SELECT completed\r\n",
            "* SEARCH 12 11\r\n",
            "a3 OK SEARCH completed\r\n",
            "* 1 FETCH (UID 12 FLAGS (\\Seen) INTERNALDATE 12345)\r\n",
        )
        .as_bytes();

        // Fresh session used for the reduced retry (no BODYSTRUCTURE). Because
        // the full query died on a parse error the structure follow-up is
        // skipped, so the flags stay false.
        const RETRY: &[u8] = concat!(
            "* OK [CAPABILITY IMAP4 IMAP4rev1] ready\r\n",
            "a1 OK LOGIN completed\r\n",
            "* FLAGS (\\Seen)\r\n",
            "* 2 EXISTS\r\n",
            "* OK [UIDVALIDITY 1] UIDs valid\r\n",
            "a2 OK [READ-WRITE] SELECT completed\r\n",
            "* 1 FETCH (UID 12 FLAGS (\\Seen) INTERNALDATE \"01-Jan-2024 00:00:00 +0000\" RFC822.SIZE 21 BODY[] {21}\r\n",
            "Subject: One\r\n\r\nhello)\r\n",
            "* 2 FETCH (UID 11 FLAGS (\\Seen) INTERNALDATE \"02-Jan-2024 00:00:00 +0000\" RFC822.SIZE 21 BODY[] {21}\r\n",
            "Subject: Two\r\n\r\nhello)\r\n",
            "a3 OK FETCH completed\r\n",
            "a4 OK NOOP completed\r\n",
        )
        .as_bytes();

        let (mut session, written_first) = open_mock_session(BROKEN);
        let (retry_session, written_retry) = open_mock_session(RETRY);
        let mut retries = VecDeque::from([retry_session]);
        let mut batches: Vec<(Vec<u32>, u32)> = Vec::new();

        let page = list_messages_streamed(
            &mut session,
            "INBOX",
            1,
            30,
            move || {
                retries
                    .pop_front()
                    .ok_or_else(|| MailError::unknown("no mock session left".to_string()))
            },
            |items, total| {
                batches.push((items.iter().map(|item| item.uid).collect(), total));
            },
        )
        .expect("reduced retry must recover the batch");

        assert_eq!(batches, vec![(vec![12, 11], 2)]);
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.total, 2);
        assert!(!page.has_more);
        assert_eq!(page.items[0].uid, 12);
        assert_eq!(page.items[1].uid, 11);
        assert!(
            page.items.iter().all(|item| !item.has_attachments),
            "a skipped structure fetch leaves the flags false"
        );

        // The retry session is in sync, so a later command does not panic.
        session.noop().expect("retry session must stay in sync");

        let first = written_commands(&written_first);
        assert!(
            first.iter().any(|command| command.contains("BODYSTRUCTURE")),
            "first attempt uses the full query: {first:?}"
        );
        let retried = written_commands(&written_retry);
        let reduced = retried
            .iter()
            .find(|command| command.contains("UID FETCH 12,11"))
            .expect("retry fetches the whole batch");
        assert!(
            !reduced.contains("BODYSTRUCTURE"),
            "reduced retry drops BODYSTRUCTURE: {retried:?}"
        );
        assert!(
            !retried
                .iter()
                .any(|command| command.contains("(UID BODYSTRUCTURE)")),
            "a parse failure must not re-send BODYSTRUCTURE: {retried:?}"
        );
    }

    #[test]
    fn reduced_failure_isolates_single_mail_and_keeps_order() {
        use std::collections::VecDeque;

        // Full batch and reduced batch both fail; the per-uid pass keeps 13 and
        // 11 while skipping the malformed 12.
        const BROKEN: &[u8] = concat!(
            "* OK [CAPABILITY IMAP4 IMAP4rev1] ready\r\n",
            "a1 OK LOGIN completed\r\n",
            "* FLAGS (\\Seen)\r\n",
            "* 3 EXISTS\r\n",
            "* OK [UIDVALIDITY 1] UIDs valid\r\n",
            "a2 OK [READ-WRITE] SELECT completed\r\n",
            "* SEARCH 13 12 11\r\n",
            "a3 OK SEARCH completed\r\n",
            "* 1 FETCH (UID 13 FLAGS (\\Seen) INTERNALDATE 12345)\r\n",
        )
        .as_bytes();
        const BROKEN_REDUCED: &[u8] = BROKEN;

        const ISOLATE: &[u8] = concat!(
            "* OK [CAPABILITY IMAP4 IMAP4rev1] ready\r\n",
            "a1 OK LOGIN completed\r\n",
            "* FLAGS (\\Seen)\r\n",
            "* 3 EXISTS\r\n",
            "* OK [UIDVALIDITY 1] UIDs valid\r\n",
            "a2 OK [READ-WRITE] SELECT completed\r\n",
            "* 1 FETCH (UID 13 FLAGS (\\Seen) INTERNALDATE \"01-Jan-2024 00:00:00 +0000\" RFC822.SIZE 21 BODY[] {21}\r\n",
            "Subject: One\r\n\r\nhello)\r\n",
            "a3 OK FETCH completed\r\n",
            "* 1 FETCH (UID 13 BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"UTF-8\") NIL NIL \"7BIT\" 5 1))\r\n",
            "a4 OK FETCH completed\r\n",
            "* 1 FETCH (UID 12 FLAGS (\\Seen) INTERNALDATE 12345)\r\n",
        )
        .as_bytes();

        const LAST: &[u8] = concat!(
            "* OK [CAPABILITY IMAP4 IMAP4rev1] ready\r\n",
            "a1 OK LOGIN completed\r\n",
            "* FLAGS (\\Seen)\r\n",
            "* 3 EXISTS\r\n",
            "* OK [UIDVALIDITY 1] UIDs valid\r\n",
            "a2 OK [READ-WRITE] SELECT completed\r\n",
            "* 1 FETCH (UID 11 FLAGS (\\Seen) INTERNALDATE \"02-Jan-2024 00:00:00 +0000\" RFC822.SIZE 21 BODY[] {21}\r\n",
            "Subject: Two\r\n\r\nhello)\r\n",
            "a3 OK FETCH completed\r\n",
            "* 1 FETCH (UID 11 BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"UTF-8\") NIL NIL \"7BIT\" 5 1))\r\n",
            "a4 OK FETCH completed\r\n",
            "a5 OK NOOP completed\r\n",
        )
        .as_bytes();

        let (mut session, _written_first) = open_mock_session(BROKEN);
        let (reduced, _written_reduced) = open_mock_session(BROKEN_REDUCED);
        let (isolate, written_isolate) = open_mock_session(ISOLATE);
        let (last, _written_last) = open_mock_session(LAST);
        let mut retries = VecDeque::from([reduced, isolate, last]);
        let mut batches: Vec<(Vec<u32>, u32)> = Vec::new();

        let page = list_messages_streamed(
            &mut session,
            "INBOX",
            1,
            30,
            move || {
                retries
                    .pop_front()
                    .ok_or_else(|| MailError::unknown("no mock session left".to_string()))
            },
            |items, total| {
                batches.push((items.iter().map(|item| item.uid).collect(), total));
            },
        )
        .expect("per-mail isolation must still return a page");

        assert_eq!(batches, vec![(vec![13, 11], 3)]);
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.total, 3, "total still reflects the search result");
        assert_eq!(page.items[0].uid, 13);
        assert_eq!(page.items[1].uid, 11);

        // The final session is in sync even after skipping a malformed mail.
        session.noop().expect("session must not keep a stale tagged reply");

        let commands = written_commands(&written_isolate);
        assert!(
            commands
                .iter()
                .any(|command| command.contains("UID FETCH 13")),
            "good mail is fetched alone: {commands:?}"
        );
    }

    #[test]
    fn reduced_retry_merges_attachment_flags_in_order() {
        // A tagged NO keeps the session in sync, so the reduced retry and the
        // structure follow-up run on the same session. Only the parse-failure
        // path skips the structure query.
        const TRANSCRIPT: &[u8] = concat!(
            "* OK [CAPABILITY IMAP4 IMAP4rev1] ready\r\n",
            "a1 OK LOGIN completed\r\n",
            "* FLAGS (\\Seen)\r\n",
            "* 2 EXISTS\r\n",
            "* OK [UIDVALIDITY 1] UIDs valid\r\n",
            "a2 OK [READ-WRITE] SELECT completed\r\n",
            "* SEARCH 12 11\r\n",
            "a3 OK SEARCH completed\r\n",
            "a4 NO BODYSTRUCTURE not supported here\r\n",
            "* 1 FETCH (UID 12 FLAGS (\\Seen) INTERNALDATE \"01-Jan-2024 00:00:00 +0000\" RFC822.SIZE 21 BODY[] {21}\r\n",
            "Subject: One\r\n\r\nhello)\r\n",
            "* 2 FETCH (UID 11 FLAGS (\\Seen) INTERNALDATE \"02-Jan-2024 00:00:00 +0000\" RFC822.SIZE 21 BODY[] {21}\r\n",
            "Subject: Two\r\n\r\nhello)\r\n",
            "a5 OK FETCH completed\r\n",
            // The structure-only reply arrives in reverse order on purpose.
            "* 1 FETCH (UID 11 BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"UTF-8\") NIL NIL \"7BIT\" 5 1))\r\n",
            "* 2 FETCH (UID 12 BODYSTRUCTURE (\"APPLICATION\" \"PDF\" (\"NAME\" \"a.pdf\") NIL NIL \"BASE64\" 10))\r\n",
            "a6 OK FETCH completed\r\n",
            "a7 OK NOOP completed\r\n",
        )
        .as_bytes();

        let (mut session, written) = open_mock_session(TRANSCRIPT);
        let mut batches: Vec<(Vec<u32>, u32)> = Vec::new();

        let page = list_messages_streamed(
            &mut session,
            "INBOX",
            1,
            30,
            || Err(MailError::unknown("reconnect must not be needed".to_string())),
            |items, total| {
                batches.push((items.iter().map(|item| item.uid).collect(), total));
            },
        )
        .expect("structure follow-up must not disturb the page");

        assert_eq!(batches, vec![(vec![12, 11], 2)]);
        assert_eq!(
            page.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            vec![12, 11],
            "structure replies must not reorder the rows"
        );
        assert!(page.items[0].has_attachments, "uid 12 has a named part");
        assert!(!page.items[1].has_attachments, "uid 11 is plain text");

        session.noop().expect("session stays in sync");

        let commands = written_commands(&written);
        assert!(
            commands
                .iter()
                .any(|command| command.contains("UID FETCH 12,11 (UID BODYSTRUCTURE)")),
            "structure is fetched for the same batch: {commands:?}"
        );
    }

    #[test]
    fn all_skipped_page_returns_error_instead_of_empty_list() {
        use std::collections::VecDeque;

        // Full, reduced and per-uid attempts all fail for the only uid.
        const BROKEN: &[u8] = concat!(
            "* OK [CAPABILITY IMAP4 IMAP4rev1] ready\r\n",
            "a1 OK LOGIN completed\r\n",
            "* FLAGS (\\Seen)\r\n",
            "* 1 EXISTS\r\n",
            "* OK [UIDVALIDITY 1] UIDs valid\r\n",
            "a2 OK [READ-WRITE] SELECT completed\r\n",
            "* SEARCH 40\r\n",
            "a3 OK SEARCH completed\r\n",
            "* 1 FETCH (UID 40 FLAGS (\\Seen) INTERNALDATE 12345)\r\n",
        )
        .as_bytes();

        let (mut session, _) = open_mock_session(BROKEN);
        let (reduced, _) = open_mock_session(BROKEN);
        let (isolated, _) = open_mock_session(BROKEN);
        let mut retries = VecDeque::from([reduced, isolated]);

        let err = list_messages_streamed(
            &mut session,
            "INBOX",
            1,
            30,
            move || {
                retries
                    .pop_front()
                    .ok_or_else(|| MailError::unknown("no mock session left".to_string()))
            },
            |_items, _total| {},
        )
        .expect_err("an entirely skipped page must not look like an empty folder");

        assert!(
            err.message.contains("本页邮件加载失败") && err.message.contains("已跳过 1 封"),
            "unexpected message: {}",
            err.message
        );
    }

    #[test]
    fn starred_scan_reconnects_after_parse_failure() {
        use std::collections::VecDeque;

        // The first scan aborts on a malformed FETCH; the fresh session gets the
        // same UIDs without BODYSTRUCTURE and must keep both rows.
        const BROKEN: &[u8] = concat!(
            "* OK [CAPABILITY IMAP4 IMAP4rev1] ready\r\n",
            "a1 OK LOGIN completed\r\n",
            "* FLAGS (\\Seen)\r\n",
            "* 2 EXISTS\r\n",
            "* OK [UIDVALIDITY 1] UIDs valid\r\n",
            "a2 OK [READ-WRITE] SELECT completed\r\n",
            "* SEARCH 31 30\r\n",
            "a3 OK SEARCH completed\r\n",
            "* 1 FETCH (UID 31 FLAGS (\\Flagged) INTERNALDATE 12345)\r\n",
        )
        .as_bytes();

        const RETRY: &[u8] = concat!(
            "* OK [CAPABILITY IMAP4 IMAP4rev1] ready\r\n",
            "a1 OK LOGIN completed\r\n",
            "* FLAGS (\\Seen)\r\n",
            "* 2 EXISTS\r\n",
            "* OK [UIDVALIDITY 1] UIDs valid\r\n",
            "a2 OK [READ-WRITE] SELECT completed\r\n",
            "* 1 FETCH (UID 31 FLAGS (\\Flagged) INTERNALDATE \"02-Jan-2024 00:00:00 +0000\" RFC822.SIZE 21 BODY[] {21}\r\n",
            "Subject: One\r\n\r\nhello)\r\n",
            "* 2 FETCH (UID 30 FLAGS (\\Flagged) INTERNALDATE \"01-Jan-2024 00:00:00 +0000\" RFC822.SIZE 21 BODY[] {21}\r\n",
            "Subject: Two\r\n\r\nhello)\r\n",
            "a3 OK FETCH completed\r\n",
            "a4 OK NOOP completed\r\n",
        )
        .as_bytes();

        let folders = [FolderInfo {
            name: "INBOX".to_string(),
            path: "INBOX".to_string(),
            kind: "inbox".to_string(),
            unread: 0,
        }];

        let (mut session, _) = open_mock_session(BROKEN);
        let (retry, written) = open_mock_session(RETRY);
        let mut retries = VecDeque::from([retry]);

        let page = list_starred(&mut session, &folders, 1, 30, || {
            retries
                .pop_front()
                .ok_or_else(|| MailError::unknown("no mock session left".to_string()))
        })
        .expect("a malformed starred message must not abort the scan");

        assert_eq!(
            page.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            vec![31, 30],
            "no starred mail may be dropped or reordered"
        );
        assert_eq!(page.total, 2);
        session.noop().expect("retry session stays in sync");

        let commands = written_commands(&written);
        assert!(
            commands
                .iter()
                .any(|command| command.contains("UID FETCH 31,30")),
            "the whole folder is retried: {commands:?}"
        );
        assert!(
            commands.iter().all(|command| !command.contains("BODYSTRUCTURE")),
            "the retry drops BODYSTRUCTURE: {commands:?}"
        );
    }

    #[test]
    fn non_utf8_bodystructure_aborts_fetch_parsing() {
        // imap-proto 0.10.2 parses every BODYSTRUCTURE string through
        // `str::from_utf8`. Coremail/QQ can put a raw GBK attachment filename
        // there, which is a hard parse error: the multi-message FETCH response
        // is abandoned and its tagged reply is left unread.
        let gbk: &[u8] = b"* 1 FETCH (UID 21 BODYSTRUCTURE (\"APPLICATION\" \"OCTET-STREAM\" (\"NAME\" \"\xC4\xE3.txt\") NIL NIL \"BASE64\" 10))\r\n";
        assert!(imap_proto::parse_response(gbk).is_err());

        let utf8: &[u8] = b"* 1 FETCH (UID 21 BODYSTRUCTURE (\"APPLICATION\" \"OCTET-STREAM\" (\"NAME\" \"ok.txt\") NIL NIL \"BASE64\" 10))\r\n";
        assert!(
            imap_proto::parse_response(utf8).is_ok(),
            "the same structure with a UTF-8 name must parse"
        );

        const FULL: &[u8] = b"* OK [CAPABILITY IMAP4 IMAP4rev1] ready\r\na1 OK LOGIN completed\r\n* 1 FETCH (UID 21 BODYSTRUCTURE (\"APPLICATION\" \"OCTET-STREAM\" (\"NAME\" \"\xC4\xE3.txt\") NIL NIL \"BASE64\" 10))\r\na2 OK FETCH completed\r\n";
        let (mut full, _) = open_mock_session(FULL);
        let err = fetch_batch(&mut full, &[21], "INBOX", true)
            .expect_err("the full query must hit the parse error");
        assert!(
            matches!(err, imap::Error::Parse(imap::error::ParseError::Invalid(_))),
            "unexpected error: {err:?}"
        );

        const REDUCED: &[u8] = b"* OK [CAPABILITY IMAP4 IMAP4rev1] ready\r\na1 OK LOGIN completed\r\n* 1 FETCH (UID 21 FLAGS () INTERNALDATE \"01-Jan-2024 00:00:00 +0000\" RFC822.SIZE 21 BODY[] {21}\r\nSubject: One\r\n\r\nhello)\r\na2 OK FETCH completed\r\n";
        let (mut reduced, _) = open_mock_session(REDUCED);
        let items = fetch_batch(&mut reduced, &[21], "INBOX", false)
            .expect("the same mail without BODYSTRUCTURE must parse");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].uid, 21);
        assert!(!items[0].has_attachments);

        // The structure-only query carries the same bytes, so it fails too and
        // the fallback keeps the paperclip flag false instead of losing the row.
        const STRUCTURE: &[u8] = b"* OK [CAPABILITY IMAP4 IMAP4rev1] ready\r\na1 OK LOGIN completed\r\n* 1 FETCH (UID 21 BODYSTRUCTURE (\"APPLICATION\" \"OCTET-STREAM\" (\"NAME\" \"\xC4\xE3.txt\") NIL NIL \"BASE64\" 10))\r\na2 OK FETCH completed\r\n";
        let (mut structure, _) = open_mock_session(STRUCTURE);
        assert!(fetch_attachment_flags(&mut structure, &[21]).is_err());
    }

    #[test]
    fn classifies_localized_handshake_timeout_as_timeout() {
        let text = "由于连接方在一段时间后没有正确答复或连接的主机没有反应，连接尝试失败。(os error 10060)";
        let err = classify_handshake_text(text);
        assert_eq!(err.code, MailErrorCode::Timeout);
        assert!(err.message.contains("超时"));
    }

    #[test]
    fn classifies_handshake_refused_as_network() {
        let err = classify_handshake_text("Connection refused (os error 10061)");
        assert_eq!(err.code, MailErrorCode::Network);
        let err = classify_handshake_text("连接被拒绝。");
        assert_eq!(err.code, MailErrorCode::Network);
    }

    #[test]
    fn classifies_other_handshake_failures_as_tls() {
        let err = classify_handshake_text("certificate verify failed");
        assert_eq!(err.code, MailErrorCode::TlsError);
    }
}
