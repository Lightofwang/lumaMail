//! Blocking connection dialing with optional HTTP CONNECT through the system
//! proxy. IMAP and SMTP both use blocking sockets, so this module is built on
//! `std::net` instead of async runtimes.
//!
//! When a proxy is configured and the target host is not bypassed, the
//! connection is tunnelled with `CONNECT`. If the proxy cannot be reached or
//! refuses the tunnel, the connection falls back to a direct connection and
//! both failure reasons are reported.

use crate::mail::error::{MailError, MailErrorCode};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IO_TIMEOUT: Duration = Duration::from_secs(30);
/// Bounds a relay write to the accepted client socket, which never carries the
/// 30 second timeout that `dial` installs on the remote socket.
const RELAY_WRITE_TIMEOUT: Duration = Duration::from_secs(30);
const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const PROXY_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PROXY_HEAD: usize = 8 * 1024;
const ACCEPT_POLL: Duration = Duration::from_millis(10);
const RELAY_POLL: Duration = Duration::from_millis(500);

/// Reads the proxy configuration from the Windows per-user Internet Settings
/// key. `ProxyEnable` must be a DWORD equal to 1; missing values or read
/// errors simply mean "no proxy" and never panic.
#[cfg(windows)]
pub(crate) fn system_proxy() -> Option<(String, Vec<String>)> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").ok()?;
    if enabled != 1 {
        return None;
    }
    let server = parse_server(&key.get_value::<String, _>("ProxyServer").ok()?)?;
    let bypass = key
        .get_value::<String, _>("ProxyOverride")
        .unwrap_or_default()
        .split(';')
        .map(|item| item.trim().to_lowercase())
        .filter(|item| !item.is_empty())
        .collect();
    Some((server, bypass))
}

/// macOS keeps the proxy configuration behind `scutil --proxy`. The result is
/// cached for 30 seconds because this is read on every connection attempt.
#[cfg(target_os = "macos")]
pub(crate) fn system_proxy() -> Option<(String, Vec<String>)> {
    type Cached = Option<(Instant, Option<(String, Vec<String>)>)>;
    static CACHE: Mutex<Cached> = Mutex::new(None);

    if let Ok(cache) = CACHE.lock() {
        if let Some((at, value)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(30) {
                return value.clone();
            }
        }
    }

    let value = std::process::Command::new("scutil")
        .arg("--proxy")
        .output()
        .ok()
        .and_then(|output| parse_scutil(&String::from_utf8_lossy(&output.stdout)));

    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), value.clone()));
    }
    value
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn system_proxy() -> Option<(String, Vec<String>)> {
    None
}

/// Parses the output of `scutil --proxy`: HTTPS is preferred over HTTP, and
/// `ExcludeSimpleHostnames` is the macOS equivalent of Windows' `<local>`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_scutil(text: &str) -> Option<(String, Vec<String>)> {
    let value = |key: &str| {
        text.lines().find_map(|line| {
            line.trim()
                .strip_prefix(key)
                .and_then(|rest| rest.trim_start().strip_prefix(':'))
                .map(|value| value.trim().to_string())
        })
    };
    let pick = |name: &str| {
        if value(&format!("{name}Enable")).as_deref() != Some("1") {
            return None;
        }
        let host = value(&format!("{name}Proxy"))?;
        let port = value(&format!("{name}Port"))?;
        Some(format!("{host}:{port}"))
    };

    let server = pick("HTTPS").or_else(|| pick("HTTP"))?;

    let mut bypass = Vec::new();
    if value("ExcludeSimpleHostnames").as_deref() == Some("1") {
        bypass.push("<local>".to_string());
    }
    let mut inside_exceptions = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("ExceptionsList") {
            inside_exceptions = true;
        } else if inside_exceptions && line.starts_with('}') {
            break;
        } else if inside_exceptions {
            if let Some((_, item)) = line.split_once(':') {
                let item = item.trim().to_lowercase();
                if !item.is_empty() {
                    bypass.push(item);
                }
            }
        }
    }

    Some((server, bypass))
}

/// Returns the proxy that should be used for `host`, or `None` when the host
/// matches the bypass list.
pub(crate) fn proxy_for(host: &str) -> Option<String> {
    let (proxy, bypass) = system_proxy()?;
    (!bypassed(host, &bypass)).then_some(proxy)
}

/// Normalizes a Windows `ProxyServer` value: either a plain `host:port`, or a
/// per-protocol list where a non-empty HTTPS entry wins over a non-empty HTTP
/// entry. User info is stripped before the value is used, so proxy credentials
/// never end up in error details. SOCKS-only values and other non-HTTP schemes
/// are not supported and yield `None`.
pub(crate) fn parse_server(value: &str) -> Option<String> {
    let value = value.trim();
    let picked = if value.contains('=') {
        let mut https = None;
        let mut http = None;
        for part in value.split(';') {
            let part = part.trim();
            let lower = part.to_ascii_lowercase();
            if let Some(rest) = lower.strip_prefix("https=") {
                if !rest.trim().is_empty() {
                    https = Some(part["https=".len()..].trim().to_string());
                }
            } else if let Some(rest) = lower.strip_prefix("http=") {
                if !rest.trim().is_empty() {
                    http = Some(part["http=".len()..].trim().to_string());
                }
            }
        }
        https.or(http)?
    } else {
        let lower = value.to_ascii_lowercase();
        let http_scheme = lower.starts_with("http://") || lower.starts_with("https://");
        if lower.contains("://") && !http_scheme {
            // socks5://, socks5h://, socks:// and friends are not proxied here.
            return None;
        }
        value.to_string()
    };

    let picked = picked
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/');
    let picked = picked.rsplit_once('@').map_or(picked, |(_, host)| host);
    (!picked.is_empty() && picked.contains(':')).then(|| picked.to_string())
}

/// Checks a host against the proxy bypass list. Supports `<local>` (a host
/// name without a dot), `*` wildcards, and IPv4 CIDR blocks.
pub(crate) fn bypassed(host: &str, list: &[String]) -> bool {
    let host = host.trim().to_ascii_lowercase();
    list.iter().any(|raw| {
        let pattern = raw.trim().to_ascii_lowercase();
        if pattern.is_empty() {
            return false;
        }
        if pattern == "<local>" {
            return !host.contains('.');
        }
        if let Some(hit) = in_cidr(&host, &pattern) {
            return hit;
        }
        match pattern.split_once('*') {
            None => pattern == host,
            Some((prefix, suffix)) => {
                host.len() >= prefix.len() + suffix.len()
                    && host.starts_with(prefix)
                    && host.ends_with(suffix)
            }
        }
    })
}

/// Matches an IPv4 host against `192.168.0.0/16` or the short `169.254/16`
/// form. Anything that is not a valid CIDR pattern (or a host that is not an
/// IPv4 literal) never matches.
fn in_cidr(host: &str, pattern: &str) -> Option<bool> {
    let (network, bits) = pattern.split_once('/')?;
    let bits: u32 = match bits.parse() {
        Ok(bits) if bits <= 32 => bits,
        _ => return Some(false),
    };
    let mut parts = Vec::new();
    for part in network.split('.') {
        match part.parse::<u8>() {
            Ok(value) => parts.push(value),
            Err(_) => return Some(false),
        }
    }
    if parts.is_empty() || parts.len() > 4 {
        return Some(false);
    }
    parts.resize(4, 0);
    let network = u32::from_be_bytes([parts[0], parts[1], parts[2], parts[3]]);
    let ip = match host.parse::<Ipv4Addr>() {
        Ok(ip) => ip,
        Err(_) => return Some(false),
    };
    let mask = if bits == 0 {
        0
    } else {
        u32::MAX << (32 - bits)
    };
    Some(u32::from(ip) & mask == network & mask)
}

/// Validates and trims a host before it is used in a `CONNECT` request line.
/// Empty hosts, whitespace/control characters (including CR/LF) and anything
/// outside the characters valid in a host name or IP literal are rejected
/// without opening a connection.
fn validate_target(host: &str) -> Result<&str, MailError> {
    let host = host.trim();
    if host.is_empty() {
        return Err(MailError::network(Some("邮件服务器地址为空".to_string())));
    }
    if let Some(bad) = host
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':')))
    {
        return Err(MailError::network(Some(format!(
            "邮件服务器地址包含非法字符 {bad:?}：{host:?}"
        ))));
    }
    Ok(host)
}

/// Formats a validated host for a `CONNECT` request line. A bare IPv6 literal
/// is bracketed, so `::1` becomes `[::1]:993`.
fn authority(host: &str, port: u16) -> String {
    let host = host.trim();
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// Dials `host:port`, using the system proxy when one applies. The boolean is
/// true when the returned stream is an HTTP CONNECT tunnel.
pub(crate) fn dial(host: &str, port: u16) -> Result<(TcpStream, bool), MailError> {
    dial_with(system_proxy(), host, port)
}

/// Same as [`dial`], but with an explicit proxy configuration. When the proxy
/// path fails, a direct connection is attempted and both reasons are reported.
pub(crate) fn dial_with(
    proxy: Option<(String, Vec<String>)>,
    host: &str,
    port: u16,
) -> Result<(TcpStream, bool), MailError> {
    let host = validate_target(host)?;

    if let Some((proxy_addr, _)) = proxy.filter(|(_, bypass)| !bypassed(host, bypass)) {
        match connect_via_proxy(&proxy_addr, host, port) {
            Ok(stream) => {
                set_io_timeout(&stream);
                return Ok((stream, true));
            }
            Err(reason) => {
                let first = format!("经代理 {proxy_addr} 连 {host}:{port} 失败：{reason}");
                return match dial_direct(host, port) {
                    Ok(stream) => Ok((stream, false)),
                    Err(err) => {
                        let detail = format!("{first}；改直连也失败：{}", reason_of(&err));
                        if err.code == MailErrorCode::Timeout {
                            Err(MailError::timeout(Some(detail)))
                        } else {
                            Err(MailError::network(Some(detail)))
                        }
                    }
                };
            }
        }
    }

    dial_direct(host, port).map(|stream| (stream, false))
}

/// Connects directly, keeping the original 15 second per-address deadline and
/// the 30 second read/write timeout.
pub(crate) fn dial_direct(host: &str, port: u16) -> Result<TcpStream, MailError> {
    let host = host.trim();
    if host.is_empty() || port == 0 {
        return Err(MailError::network(Some(
            "服务器地址或端口为空".to_string(),
        )));
    }

    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| MailError::from_io(&e))?
        .collect::<Vec<_>>();

    if addrs.is_empty() {
        return Err(MailError::network(Some(format!(
            "无法解析邮件服务器地址：{host}"
        ))));
    }

    let mut last_error: Option<io::Error> = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(stream) => {
                set_io_timeout(&stream);
                return Ok(stream);
            }
            Err(e) => last_error = Some(e),
        }
    }

    Err(last_error
        .map(|e| MailError::from_io(&e))
        .unwrap_or_else(|| MailError::network(Some(format!("无法连接到 {host}:{port}")))))
}

fn set_io_timeout(stream: &TcpStream) {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
}

/// Connects to the proxy (5 second deadline) and negotiates the CONNECT
/// tunnel (20 second overall deadline).
fn connect_via_proxy(proxy: &str, host: &str, port: u16) -> Result<TcpStream, String> {
    let addrs = proxy
        .to_socket_addrs()
        .map_err(|e| format!("无法解析代理地址 {proxy}：{e}"))?
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err(format!("无法解析代理地址 {proxy}"));
    }

    let mut last_error: Option<io::Error> = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, PROXY_CONNECT_TIMEOUT) {
            Ok(stream) => return tunnel(stream, host, port),
            Err(e) => last_error = Some(e),
        }
    }

    Err(last_error
        .map(|e| e.to_string())
        .unwrap_or_else(|| format!("无法连接到代理 {proxy}")))
}

/// Sends `CONNECT host:port` and reads the response header one byte at a time
/// so that a server greeting following the header stays in the stream for the
/// TLS/IMAP layer. The read deadline is 20 seconds, the write timeout is 20
/// seconds, so the worst case is slightly over 20 seconds; the header is
/// capped at 8 KiB.
fn tunnel(mut stream: TcpStream, host: &str, port: u16) -> Result<TcpStream, String> {
    let deadline = Instant::now() + PROXY_HANDSHAKE_TIMEOUT;
    let _ = stream.set_write_timeout(Some(PROXY_HANDSHAKE_TIMEOUT));

    let target = authority(host, port);
    let request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("发送 CONNECT 请求失败：{e}"))?;

    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
        if head.len() >= MAX_PROXY_HEAD {
            return Err("代理响应头过长".to_string());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining < Duration::from_millis(1) {
            return Err("代理 CONNECT 握手超时".to_string());
        }
        if stream.set_read_timeout(Some(remaining)).is_err() {
            return Err("无法设置代理读取超时".to_string());
        }
        match stream.read(&mut byte) {
            Ok(0) => return Err("代理断开了连接".to_string()),
            Ok(_) => head.push(byte[0]),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                return Err("代理 CONNECT 握手超时".to_string())
            }
            Err(e) => return Err(format!("读取代理响应失败：{e}")),
        }
    }

    let status_line = String::from_utf8_lossy(&head)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if status_line.split_whitespace().nth(1) == Some("200") {
        Ok(stream)
    } else {
        Err(format!("代理拒绝：{status_line}"))
    }
}

fn reason_of(err: &MailError) -> String {
    err.detail
        .clone()
        .filter(|detail| !detail.is_empty())
        .unwrap_or_else(|| err.message.clone())
}

/// A loopback TCP relay used for SMTP. lettre 0.11 creates its own socket, so a
/// real CONNECT tunnel cannot be injected into it. Instead lettre connects to
/// this relay, which forwards to the real server (through the proxy if needed).
/// TLS still runs end-to-end with the real host as SNI/certificate name.
pub(crate) struct Forwarder {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    hint: Arc<Mutex<Option<String>>>,
    handle: Option<JoinHandle<()>>,
}

impl Forwarder {
    pub(crate) fn start(host: &str, port: u16) -> Result<Self, MailError> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| {
            MailError::network(Some(format!("无法启动本地 SMTP 转发器：{e}")))
        })?;
        listener
            .set_nonblocking(true)
            .map_err(|e| MailError::network(Some(format!("无法配置本地 SMTP 转发器：{e}"))))?;
        let addr = listener
            .local_addr()
            .map_err(|e| MailError::network(Some(format!("无法读取本地 SMTP 转发器地址：{e}"))))?;

        let stop = Arc::new(AtomicBool::new(false));
        let hint: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let host = host.trim().to_string();
        let thread_stop = Arc::clone(&stop);
        let thread_hint = Arc::clone(&hint);
        let handle = thread::Builder::new()
            .name("luma-smtp-forwarder".to_string())
            .spawn(move || accept_loop(listener, host, port, thread_stop, thread_hint))
            .map_err(|e| MailError::unknown(format!("无法启动本地 SMTP 转发线程：{e}")))?;

        Ok(Self {
            addr,
            stop,
            hint,
            handle: Some(handle),
        })
    }

    pub(crate) fn port(&self) -> u16 {
        self.addr.port()
    }

    /// Returns the last connection failure, if any. The SMTP layer appends it
    /// to the error detail so the user sees why the proxy/forwarder failed.
    pub(crate) fn take_hint(&self) -> Option<String> {
        self.hint.lock().ok().and_then(|mut hint| hint.take())
    }
}

impl Drop for Forwarder {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Wake the non-blocking accept loop; it exits on the stop flag. If the
        // one-shot listener is already closed this connect fails, which is
        // expected and must not be reported.
        let _ = TcpStream::connect_timeout(&self.addr, Duration::from_millis(200));

        if let Some(handle) = self.handle.take() {
            // The relay polls `stop` every 500ms, so in normal operation the
            // thread exits well within this budget. A blocked dial cannot be
            // interrupted on Windows, so bound the wait instead of hanging the
            // drop; the thread observes `stop` and exits as soon as dial
            // returns.
            let deadline = Instant::now() + Duration::from_secs(2);
            while !handle.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            if handle.is_finished() {
                let _ = handle.join();
            }
        }
    }
}

/// Accepts and serves exactly one loopback connection, then returns so the
/// listener is closed. lettre opens at most one connection per send/test; a
/// second connection must fail instead of reaching an unattended local port.
fn accept_loop(
    listener: TcpListener,
    host: String,
    port: u16,
    stop: Arc<AtomicBool>,
    hint: Arc<Mutex<Option<String>>>,
) {
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((client, _)) => {
                if stop.load(Ordering::Relaxed) {
                    let _ = client.shutdown(Shutdown::Both);
                    return;
                }
                serve_client(client, &host, port, &stop, &hint);
                return;
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => thread::sleep(ACCEPT_POLL),
            Err(_) => return,
        }
    }
}

/// Handles the single accepted loopback connection. The accepted socket gets a
/// 30 second write timeout so a stalled peer cannot block the pump forever
/// while reads still poll every 500ms.
fn serve_client(
    client: TcpStream,
    host: &str,
    port: u16,
    stop: &Arc<AtomicBool>,
    hint: &Arc<Mutex<Option<String>>>,
) {
    let remote = match dial(host, port) {
        Ok((remote, _)) => remote,
        Err(err) => {
            if let Ok(mut slot) = hint.lock() {
                *slot = Some(reason_of(&err));
            }
            // Close the local socket so lettre fails immediately instead of
            // waiting for its own timeout.
            let _ = client.shutdown(Shutdown::Both);
            return;
        }
    };

    let (client_reader, remote_writer) = match (client.try_clone(), remote.try_clone()) {
        (Ok(client_reader), Ok(remote_writer)) => (client_reader, remote_writer),
        _ => {
            if let Ok(mut slot) = hint.lock() {
                *slot = Some("无法复制本地转发器套接字".to_string());
            }
            let _ = client.shutdown(Shutdown::Both);
            let _ = remote.shutdown(Shutdown::Both);
            return;
        }
    };

    let _ = client.set_write_timeout(Some(RELAY_WRITE_TIMEOUT));
    let _ = client.set_read_timeout(Some(RELAY_POLL));
    let _ = remote.set_read_timeout(Some(RELAY_POLL));

    let up_stop = Arc::clone(stop);
    let up = thread::Builder::new()
        .name("luma-smtp-forward".to_string())
        .spawn(move || pump(client_reader, remote_writer, &up_stop));
    let down_stop = Arc::clone(stop);
    let down = thread::Builder::new()
        .name("luma-smtp-back".to_string())
        .spawn(move || pump(remote, client, &down_stop));

    if let Ok(handle) = up {
        let _ = handle.join();
    }
    if let Ok(handle) = down {
        let _ = handle.join();
    }
}

/// Copies bytes in one direction until EOF, error, or stop. Reads poll with a
/// 500ms timeout so the relay can shut down promptly; the destination socket
/// has a 30 second write timeout so a stalled peer cannot block forever. When
/// the pump ends it shuts down the opposite socket, which unblocks the other
/// direction.
fn pump(mut from: TcpStream, mut to: TcpStream, stop: &AtomicBool) {
    let mut buffer = [0u8; 16 * 1024];
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match from.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                if to.write_all(&buffer[..n]).is_err() {
                    break;
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) =>
            {
                continue
            }
            Err(_) => break,
        }
    }
    let _ = to.shutdown(Shutdown::Both);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proxy_server_forms() {
        assert_eq!(
            parse_server("127.0.0.1:7890").as_deref(),
            Some("127.0.0.1:7890")
        );
        assert_eq!(
            parse_server("http=127.0.0.1:1080;https=127.0.0.1:1081;socks=127.0.0.1:1082")
                .as_deref(),
            Some("127.0.0.1:1081")
        );
        assert_eq!(
            parse_server("http://proxy.lan:8080/").as_deref(),
            Some("proxy.lan:8080")
        );
        assert_eq!(parse_server("socks=127.0.0.1:1080"), None);
        // An empty HTTPS entry falls back to a non-empty HTTP entry.
        assert_eq!(
            parse_server("https=;http=127.0.0.1:7890").as_deref(),
            Some("127.0.0.1:7890")
        );
        assert_eq!(parse_server("https=;http="), None);
        assert_eq!(parse_server("socks5://127.0.0.1:1080"), None);
        assert_eq!(parse_server("socks5h://127.0.0.1:1080"), None);
    }

    #[test]
    fn strips_proxy_userinfo() {
        assert_eq!(
            parse_server("http://user:pass@proxy.lan:8080").as_deref(),
            Some("proxy.lan:8080")
        );
        assert_eq!(
            parse_server("https=user:pass@proxy.lan:8443").as_deref(),
            Some("proxy.lan:8443")
        );
    }

    #[test]
    fn formats_connect_authority() {
        assert_eq!(authority("::1", 993), "[::1]:993");
        assert_eq!(authority("imap.gmail.com", 993), "imap.gmail.com:993");
    }

    #[test]
    fn rejects_invalid_connect_targets() {
        for host in [
            "",
            "   ",
            "imap.example.com\r\nX: y",
            "imap.example.com\nX: y",
            "imap example.com",
            "imap.example.com/",
        ] {
            let err = dial_with(None, host, 993).unwrap_err();
            assert_eq!(err.code, MailErrorCode::Network, "host {host:?}");
            assert!(
                err.detail
                    .as_deref()
                    .is_some_and(|detail| !detail.is_empty()),
                "host {host:?} has no detail"
            );
        }
        let err = dial_with(None, "imap.example.com\r\nX: y", 993).unwrap_err();
        assert!(
            err.detail.unwrap_or_default().contains("非法字符"),
            "detail should name the invalid character"
        );
    }

    #[test]
    fn matches_bypass_rules() {
        let list: Vec<String> = ["localhost", "127.*", "*.corp.cn", "<local>"]
            .iter()
            .map(|item| item.to_string())
            .collect();
        assert!(bypassed("127.0.0.1", &list));
        assert!(bypassed("mail.corp.cn", &list));
        assert!(bypassed("intranet", &list));
        assert!(!bypassed("imap.gmail.com", &list));

        let cidr: Vec<String> = ["192.168.0.0/16", "169.254/16"]
            .iter()
            .map(|item| item.to_string())
            .collect();
        assert!(bypassed("192.168.1.10", &cidr));
        assert!(bypassed("169.254.3.4", &cidr));
        assert!(!bypassed("10.0.0.1", &cidr));
        assert!(!bypassed("mail.example.com", &cidr));

        let invalid: Vec<String> = ["192.168.0.0/99", "not-a-cidr/16"]
            .iter()
            .map(|item| item.to_string())
            .collect();
        assert!(!bypassed("192.168.1.10", &invalid));
    }

    #[test]
    fn parses_scutil_output() {
        let text = "<dictionary> {\n  ExceptionsList : <array> {\n    0 : 127.0.0.1\n    1 : *.local\n  }\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 7891\n  HTTPSProxy : 127.0.0.1\n}";
        let (server, bypass) = parse_scutil(text).unwrap();
        assert_eq!(server, "127.0.0.1:7891");
        assert_eq!(bypass, vec!["127.0.0.1", "*.local"]);
        assert!(parse_scutil("<dictionary> {\n  HTTPEnable : 0\n}").is_none());
    }

    /// The fake proxy sends a greeting immediately after the CONNECT response;
    /// the tunnel must not consume those bytes.
    #[test]
    fn tunnel_keeps_server_greeting() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 512];
            let n = socket.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..n])
                .starts_with("CONNECT imap.example.com:993 HTTP/1.1"));
            socket
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n* OK hello\r\n")
                .unwrap();
        });

        let stream = TcpStream::connect(addr).unwrap();
        let mut stream = tunnel(stream, "imap.example.com", 993).unwrap();
        let mut greeting = [0u8; 12];
        stream.read_exact(&mut greeting).unwrap();
        assert_eq!(&greeting, b"* OK hello\r\n");
        server.join().unwrap();
    }

    #[test]
    fn tunnel_reports_proxy_status() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 512];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                .unwrap();
        });

        let stream = TcpStream::connect(addr).unwrap();
        let err = tunnel(stream, "imap.example.com", 993).unwrap_err();
        assert!(err.contains("502 Bad Gateway"), "{err}");
        server.join().unwrap();
    }

    #[test]
    fn falls_back_to_direct_when_proxy_refuses() {
        let target = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let target_port = target.local_addr().unwrap().port();
        let target_thread = thread::spawn(move || {
            let (mut socket, _) = target.accept().unwrap();
            let mut buffer = [0u8; 16];
            let n = socket.read(&mut buffer).unwrap();
            assert_eq!(&buffer[..n], b"PING");
            socket.write_all(b"PONG").unwrap();
        });

        let proxy = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let proxy_addr = proxy.local_addr().unwrap();
        let proxy_thread = thread::spawn(move || {
            let (mut socket, _) = proxy.accept().unwrap();
            let mut request = [0u8; 512];
            let _ = socket.read(&mut request).unwrap();
            socket.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").unwrap();
        });

        let (mut stream, proxied) = dial_with(
            Some((proxy_addr.to_string(), Vec::new())),
            "127.0.0.1",
            target_port,
        )
        .unwrap();
        assert!(!proxied, "proxy refused the tunnel, direct fallback expected");

        stream.write_all(b"PING").unwrap();
        let mut reply = [0u8; 4];
        stream.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"PONG");

        proxy_thread.join().unwrap();
        target_thread.join().unwrap();
    }

    #[test]
    fn forwarder_relays_bytes_and_stops_cleanly() {
        let relay = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let relay_port = relay.local_addr().unwrap().port();
        let relay_thread = thread::spawn(move || {
            let (mut socket, _) = relay.accept().unwrap();
            let mut buffer = [0u8; 8];
            let n = socket.read(&mut buffer).unwrap();
            assert_eq!(&buffer[..n], b"EHLO x\r\n");
            socket.write_all(b"250 ok\r\n").unwrap();
            thread::sleep(Duration::from_millis(50));
        });

        let forwarder = Forwarder::start("127.0.0.1", relay_port).unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", forwarder.port())).unwrap();
        client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();

        client.write_all(b"EHLO x\r\n").unwrap();
        let mut reply = [0u8; 8];
        client.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"250 ok\r\n");

        let started = Instant::now();
        drop(forwarder);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "forwarder drop took {:?}",
            started.elapsed()
        );
        relay_thread.join().unwrap();
    }

    #[test]
    fn forwarder_serves_a_single_connection_then_closes() {
        let relay = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let relay_port = relay.local_addr().unwrap().port();
        let relay_thread = thread::spawn(move || {
            let (mut socket, _) = relay.accept().unwrap();
            let mut buffer = [0u8; 8];
            let n = socket.read(&mut buffer).unwrap();
            assert_eq!(&buffer[..n], b"EHLO x\r\n");
            socket.write_all(b"250 ok\r\n").unwrap();
            // Wait for the forwarder to close its side so the pumps see EOF.
            let mut sink = [0u8; 8];
            let _ = socket.read(&mut sink);
        });

        let forwarder = Forwarder::start("127.0.0.1", relay_port).unwrap();
        let addr = SocketAddr::from(([127, 0, 0, 1], forwarder.port()));

        let mut client = TcpStream::connect(addr).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client.write_all(b"EHLO x\r\n").unwrap();
        let mut reply = [0u8; 8];
        client.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"250 ok\r\n");
        drop(client);

        // The one-shot listener must be closed (or reset the new connection)
        // within 2 seconds; it must never relay a second connection.
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut closed = false;
        while Instant::now() < deadline {
            match TcpStream::connect_timeout(&addr, Duration::from_millis(100)) {
                Err(_) => {
                    closed = true;
                    break;
                }
                Ok(mut second) => {
                    second
                        .set_read_timeout(Some(Duration::from_millis(100)))
                        .unwrap();
                    let mut byte = [0u8; 1];
                    match second.read(&mut byte) {
                        Ok(0) => {
                            closed = true;
                            break;
                        }
                        Err(e)
                            if matches!(
                                e.kind(),
                                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                            ) =>
                        {
                            continue
                        }
                        Err(_) => {
                            closed = true;
                            break;
                        }
                        Ok(_) => panic!("forwarder relayed a second connection"),
                    }
                }
            }
        }
        assert!(
            closed,
            "forwarder listener still open 2s after serving one connection"
        );

        let started = Instant::now();
        drop(forwarder);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "forwarder drop took {:?}",
            started.elapsed()
        );
        relay_thread.join().unwrap();
    }

    /// Manual network check: `cargo test --release --bins dial_reads -- --ignored --nocapture`.
    #[test]
    #[ignore = "requires network access to imap.qq.com:993 and imap.gmail.com:993"]
    fn dial_reads_imap_greeting() {
        for host in ["imap.qq.com", "imap.gmail.com"] {
            let (stream, proxied) =
                dial(host, 993).unwrap_or_else(|e| panic!("{host}:993 dial failed: {e:?}"));
            // 993 is implicit TLS, so the server only sends its greeting after
            // the handshake. Complete it exactly like `imap_client::connect`.
            let connector = native_tls::TlsConnector::builder()
                .build()
                .expect("build TLS connector");
            let mut stream = connector
                .connect(host, stream)
                .unwrap_or_else(|e| panic!("{host}:993 TLS handshake failed: {e}"));
            let mut line = Vec::new();
            let mut byte = [0u8; 1];
            loop {
                match stream.read(&mut byte) {
                    Ok(0) => break,
                    Ok(_) => {
                        line.push(byte[0]);
                        if byte[0] == b'\n' {
                            break;
                        }
                    }
                    Err(e) => panic!("{host}:993 read failed: {e}"),
                }
            }
            let greeting = String::from_utf8_lossy(&line).trim_end().to_string();
            println!("{host}:993 proxied={proxied} first_line={greeting}");
            assert!(
                greeting.starts_with("* OK"),
                "{host}:993 unexpected greeting: {greeting}"
            );
        }
    }
}
