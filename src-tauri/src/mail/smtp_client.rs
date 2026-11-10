use crate::mail::error::MailError;
use crate::mail::models::{AccountConfig, SendRequest};
use crate::mail::net;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, Message, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::transport::smtp::SmtpTransport;
use lettre::Address;
use lettre::Transport;
use std::fs;
use std::str::FromStr;
use std::time::Duration;

const SMTP_TIMEOUT: Duration = Duration::from_secs(30);
/// Through the loopback relay the failure is reported by the forwarder after
/// proxy connect (5s) + CONNECT handshake (20s) + direct fallback (15s per
/// address), so lettre needs a budget large enough to receive that hint.
const SMTP_PROXY_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;

/// A built SMTP transport plus the loopback relay it may depend on. The
/// fields are ordered so the lettre transport is dropped (closing its socket)
/// before the relay thread is stopped.
struct SmtpClient {
    transport: SmtpTransport,
    forwarder: Option<net::Forwarder>,
}

impl SmtpClient {
    /// Reports why the loopback relay could not reach the real server, if it
    /// failed. Appended to the SMTP error detail by the caller.
    fn hint(&self) -> Option<String> {
        self.forwarder.as_ref().and_then(|forwarder| forwarder.take_hint())
    }
}

/// Deliberately opaque: `SmtpTransport`'s own `Debug` includes credentials.
impl std::fmt::Debug for SmtpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmtpClient")
            .field("proxied", &self.forwarder.is_some())
            .finish()
    }
}

/// Builds an encrypted SMTP transport. Plaintext SMTP is never used: `ssl`
/// means implicit TLS and `starttls` means a required STARTTLS upgrade.
///
/// lettre creates its own socket, so a CONNECT tunnel cannot be injected into
/// it directly. When a system proxy applies, a loopback relay is started and
/// lettre connects to it; TLS still runs against the real host name, so SNI
/// and certificate validation are unchanged.
fn transport(account: &AccountConfig, password: &str) -> Result<SmtpClient, MailError> {
    let security = account.smtp.security.to_ascii_lowercase();
    if security != "ssl" && security != "starttls" {
        return Err(MailError::tls(Some(
            "SMTP 仅支持 SSL/TLS 或 STARTTLS 加密连接".to_string(),
        )));
    }

    let host = account.smtp.host.trim();
    let port = account.smtp.port;
    if host.is_empty() || port == 0 {
        return Err(MailError::network(Some(
            "服务器地址或端口为空".to_string(),
        )));
    }

    let (builder, forwarder) = if net::proxy_for(host).is_some() {
        let forwarder = net::Forwarder::start(host, port)?;
        let params = TlsParameters::new(host.to_string())
            .map_err(|e| MailError::tls(Some(format!("无法初始化 SMTP TLS 参数：{e}"))))?;
        let tls = if security == "ssl" {
            Tls::Wrapper(params)
        } else {
            Tls::Required(params)
        };
        (
            SmtpTransport::builder_dangerous("127.0.0.1")
                .port(forwarder.port())
                .tls(tls),
            Some(forwarder),
        )
    } else {
        // Fail fast with our own 15 second connect deadline before handing the
        // host to lettre.
        let _ = net::dial_direct(host, port)?;
        let builder = if security == "ssl" {
            SmtpTransport::relay(host)
        } else {
            SmtpTransport::starttls_relay(host)
        }
        .map_err(|e| MailError::unknown(format!("无法初始化 SMTP 连接：{e}")))?
        .port(port);
        (builder, None)
    };

    let timeout = if forwarder.is_some() {
        SMTP_PROXY_TIMEOUT
    } else {
        SMTP_TIMEOUT
    };

    Ok(SmtpClient {
        transport: builder
            .credentials(Credentials::new(
                account.username.clone(),
                password.to_string(),
            ))
            .timeout(Some(timeout))
            .build(),
        forwarder,
    })
}

/// Performs an EHLO/STARTTLS/AUTH handshake and closes the connection. This is
/// used by `account_test`, so a returned error already proves the credentials
/// failed (or the server is unreachable).
pub fn test(account: &AccountConfig, password: &str) -> Result<(), MailError> {
    let client = transport(account, password)?;
    if let Err(e) = client.transport.test_connection() {
        return Err(MailError::from_smtp(&e).with_hint(client.hint()));
    }
    Ok(())
}

fn parse_recipients(value: &str, label: &str) -> Result<Vec<Mailbox>, MailError> {
    let mut result = Vec::new();
    for part in value.split([',', ';']) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        result.push(Mailbox::from_str(part).map_err(|_| {
            MailError::invalid(format!("{label}地址格式不正确：{part}"))
        })?);
    }
    Ok(result)
}

fn content_type_for(name: &str) -> ContentType {
    let extension = name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "rar" => "application/vnd.rar",
        "7z" => "application/x-7z-compressed",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    };
    ContentType::parse(mime).unwrap_or_else(|_| {
        ContentType::parse("application/octet-stream").expect("static content type")
    })
}

/// Builds the RFC 5322 message. The HTML passed by the UI has already been
/// sanitized client side; this function only assembles MIME parts.
pub fn build_message(account: &AccountConfig, request: &SendRequest) -> Result<Message, MailError> {
    let to = parse_recipients(&request.to, "收件人")?;
    let cc = parse_recipients(&request.cc, "抄送")?;
    let bcc = parse_recipients(&request.bcc, "密送")?;

    if to.is_empty() && cc.is_empty() && bcc.is_empty() {
        return Err(MailError::invalid("请填写至少一个收件人"));
    }

    let address = Address::from_str(account.email.trim())
        .map_err(|_| MailError::invalid("当前账号的邮箱地址无效，请重新添加账号"))?;
    let display_name = if account.display_name.trim().is_empty() {
        None
    } else {
        Some(account.display_name.trim().to_string())
    };
    let from = Mailbox::new(display_name, address);

    let mut builder = Message::builder()
        .from(from)
        .subject(request.subject.trim().to_string())
        .message_id(None);

    for mailbox in to {
        builder = builder.to(mailbox);
    }
    for mailbox in cc {
        builder = builder.cc(mailbox);
    }
    for mailbox in bcc {
        builder = builder.bcc(mailbox);
    }

    let text = if request.text.trim().is_empty() {
        " ".to_string()
    } else {
        request.text.clone()
    };

    if request.attachments.is_empty() {
        if request.html.trim().is_empty() {
            return builder
                .singlepart(SinglePart::plain(text))
                .map_err(|e| MailError::unknown(format!("无法生成邮件内容：{e}")));
        }
        return builder
            .multipart(MultiPart::alternative_plain_html(text, request.html.clone()))
            .map_err(|e| MailError::unknown(format!("无法生成邮件内容：{e}")));
    }

    let alternative = if request.html.trim().is_empty() {
        MultiPart::mixed().singlepart(SinglePart::plain(text))
    } else {
        MultiPart::mixed().multipart(MultiPart::alternative_plain_html(
            text,
            request.html.clone(),
        ))
    };

    let mut body = alternative;
    for attachment in &request.attachments {
        let metadata = fs::metadata(&attachment.path)
            .map_err(|e| MailError::invalid(format!("无法读取附件 {}：{e}", attachment.name)))?;
        if !metadata.is_file() {
            return Err(MailError::invalid(format!(
                "附件不是一个文件：{}",
                attachment.name
            )));
        }
        if metadata.len() > MAX_ATTACHMENT_BYTES {
            return Err(MailError::too_large(format!(
                "附件 {} 超过 25MB，请压缩后再发送",
                attachment.name
            )));
        }
        let bytes = fs::read(&attachment.path)
            .map_err(|e| MailError::invalid(format!("无法读取附件 {}：{e}", attachment.name)))?;
        let part = Attachment::new(attachment.name.clone())
            .body(bytes, content_type_for(&attachment.name));
        body = body.singlepart(part);
    }

    builder
        .multipart(body)
        .map_err(|e| MailError::unknown(format!("无法生成邮件内容：{e}")))
}

/// Sends the message through SMTP. Returns the formatted raw message so the
/// caller can append a copy to the Sent folder.
pub fn send(
    account: &AccountConfig,
    password: &str,
    request: &SendRequest,
) -> Result<Vec<u8>, MailError> {
    let message = build_message(account, request)?;
    let client = transport(account, password)?;
    if let Err(e) = client.transport.send(&message) {
        return Err(MailError::from_smtp(&e).with_hint(client.hint()));
    }
    Ok(message.formatted())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::models::ServerConfig;

    fn account() -> AccountConfig {
        AccountConfig {
            id: "acc".into(),
            provider: "qq".into(),
            email: "sender@qq.com".into(),
            display_name: "发件人".into(),
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
            username: "sender@qq.com".into(),
        }
    }

    fn request() -> SendRequest {
        SendRequest {
            to: "a@example.com, b@example.com".into(),
            cc: String::new(),
            bcc: String::new(),
            subject: "测试主题".into(),
            html: "<p>你好</p>".into(),
            text: "你好".into(),
            attachments: Vec::new(),
        }
    }

    #[test]
    fn builds_alternative_message_with_recipients() {
        let message = build_message(&account(), &request()).unwrap();
        let raw = String::from_utf8_lossy(&message.formatted()).to_string();
        assert!(raw.contains("To: a@example.com"));
        assert!(raw.contains("Subject:"));
        assert!(raw.contains("multipart/alternative"));
    }

    #[test]
    fn rejects_empty_recipients() {
        let mut request = request();
        request.to.clear();
        let err = build_message(&account(), &request).unwrap_err();
        assert!(err.message.contains("收件人"));
    }

    #[test]
    fn rejects_plaintext_security() {
        let mut account = account();
        account.smtp.security = "none".into();
        let err = transport(&account, "secret").unwrap_err();
        assert_eq!(err.code, crate::mail::error::MailErrorCode::TlsError);
    }

    #[test]
    fn guesses_common_content_types() {
        assert_eq!(
            content_type_for("a.PDF"),
            ContentType::parse("application/pdf").unwrap()
        );
        assert_eq!(
            content_type_for("a.unknown"),
            ContentType::parse("application/octet-stream").unwrap()
        );
    }

    /// Manual network check: verifies implicit TLS end to end through the
    /// loopback forwarder against the real server. No credentials are set, so
    /// `test_connection` only performs the greeting/EHLO/NOOP exchange.
    /// Run with: `cargo test --release --bins proxied_ -- --ignored --nocapture`.
    #[test]
    #[ignore = "requires network access through the system proxy to smtp.qq.com:465"]
    fn proxied_ssl_transport_reaches_smtp() {
        const HOST: &str = "smtp.qq.com";
        const PORT: u16 = 465;

        if net::proxy_for(HOST).is_none() {
            println!("跳过 {HOST}:{PORT}：系统未配置代理，或该主机在代理绕过列表中");
            return;
        }

        let forwarder = net::Forwarder::start(HOST, PORT).unwrap_or_else(|e| {
            panic!("无法启动 {HOST}:{PORT} 的本地转发器：{e:?}")
        });
        let params = TlsParameters::new(HOST.to_string())
            .unwrap_or_else(|e| panic!("无法初始化 {HOST} 的 TLS 参数：{e}"));

        let transport = SmtpTransport::builder_dangerous("127.0.0.1")
            .port(forwarder.port())
            .tls(Tls::Wrapper(params))
            .timeout(Some(SMTP_TIMEOUT))
            .build();

        match transport.test_connection() {
            Ok(true) => {
                println!(
                    "{HOST}:{PORT} proxied=true tls=wrapper forwarder={} noop=ok",
                    forwarder.port()
                );
            }
            Ok(false) => panic!("{HOST}:{PORT} TLS 已建立但 NOOP 未成功"),
            Err(e) => {
                let hint = forwarder.take_hint();
                panic!(
                    "{HOST}:{PORT} 经转发器 TLS 握手/NOOP 失败：{e:?}；转发器错误：{hint:?}"
                );
            }
        }
    }

    /// Manual network check: verifies the STARTTLS upgrade through the loopback
    /// forwarder against the real server. `Tls::Required` makes lettre fail if
    /// the server does not advertise STARTTLS.
    /// Run with: `cargo test --release --bins proxied_ -- --ignored --nocapture`.
    #[test]
    #[ignore = "requires network access through the system proxy to smtp.qq.com:587"]
    fn proxied_starttls_transport_reaches_smtp() {
        const HOST: &str = "smtp.qq.com";
        const PORT: u16 = 587;

        if net::proxy_for(HOST).is_none() {
            println!("跳过 {HOST}:{PORT}：系统未配置代理，或该主机在代理绕过列表中");
            return;
        }

        let forwarder = net::Forwarder::start(HOST, PORT).unwrap_or_else(|e| {
            panic!("无法启动 {HOST}:{PORT} 的本地转发器：{e:?}")
        });
        let params = TlsParameters::new(HOST.to_string())
            .unwrap_or_else(|e| panic!("无法初始化 {HOST} 的 TLS 参数：{e}"));

        let transport = SmtpTransport::builder_dangerous("127.0.0.1")
            .port(forwarder.port())
            .tls(Tls::Required(params))
            .timeout(Some(SMTP_TIMEOUT))
            .build();

        match transport.test_connection() {
            Ok(true) => {
                println!(
                    "{HOST}:{PORT} proxied=true tls=required(starttls) forwarder={} noop=ok",
                    forwarder.port()
                );
            }
            Ok(false) => panic!("{HOST}:{PORT} STARTTLS 已升级但 NOOP 未成功"),
            Err(e) => {
                let hint = forwarder.take_hint();
                panic!(
                    "{HOST}:{PORT} 经转发器 STARTTLS/NOOP 失败：{e:?}；转发器错误：{hint:?}"
                );
            }
        }
    }
}
