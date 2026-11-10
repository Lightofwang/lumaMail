use serde::Serialize;
use std::fmt;
use std::io;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MailErrorCode {
    AuthFailed,
    ImapDisabled,
    TlsError,
    Network,
    Timeout,
    NoAccount,
    NotFound,
    TooLarge,
    DeleteNeedsConfirm,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailError {
    pub code: MailErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl fmt::Display for MailError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for MailError {}

impl MailError {
    fn new(code: MailErrorCode, message: &str, detail: Option<String>) -> Self {
        Self {
            code,
            message: message.to_string(),
            // Keep enough raw text for `redact` to find a secret that straddles
            // the final 600-char cut; redact does the user-facing truncation.
            detail: detail.map(|d| d.chars().take(4000).collect()),
        }
    }

    pub fn auth(detail: Option<String>) -> Self {
        Self::new(
            MailErrorCode::AuthFailed,
            "邮箱地址或授权码不正确；163/126/QQ 需要使用网页版设置里生成的客户端授权码，不是登录密码；同时确认已开启 IMAP/SMTP 服务",
            detail,
        )
    }

    /// Adds the protocol stage that failed so the form can tell the user
    /// whether the receiving or sending leg was rejected.
    pub fn with_stage(mut self, stage: &str) -> Self {
        self.message = format!("{stage}：{}", self.message);
        self
    }

    /// Appends an out-of-band diagnostic (for example the local SMTP
    /// forwarder's connection failure) to the detail. Redaction still runs on
    /// the whole string afterwards.
    pub fn with_hint(mut self, hint: Option<String>) -> Self {
        if let Some(hint) = hint.filter(|hint| !hint.trim().is_empty()) {
            self.detail = Some(match self.detail.take() {
                Some(detail) if !detail.is_empty() => format!("{detail}；{hint}"),
                _ => hint,
            });
        }
        self
    }

    pub fn login_too_frequent(detail: Option<String>) -> Self {
        Self::new(
            MailErrorCode::AuthFailed,
            "登录过于频繁，请稍后再试",
            detail,
        )
    }

    pub fn imap_disabled(detail: Option<String>) -> Self {
        Self::new(
            MailErrorCode::ImapDisabled,
            "该邮箱尚未开启 IMAP 服务，请先在网页版设置中开启",
            detail,
        )
    }

    pub fn tls(detail: Option<String>) -> Self {
        Self::new(
            MailErrorCode::TlsError,
            "服务器证书校验失败，无法建立安全连接",
            detail,
        )
    }

    pub fn network(detail: Option<String>) -> Self {
        Self::new(
            MailErrorCode::Network,
            "无法连接到邮件服务器，请检查网络或服务器地址",
            detail,
        )
    }

    pub fn timeout(detail: Option<String>) -> Self {
        Self::new(
            MailErrorCode::Timeout,
            "连接邮件服务器超时，请稍后重试",
            detail,
        )
    }

    pub fn no_account() -> Self {
        Self::new(MailErrorCode::NoAccount, "请先添加邮箱账号", None)
    }

    pub fn not_found(message: &str) -> Self {
        Self::new(MailErrorCode::NotFound, message, None)
    }

    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(MailErrorCode::TooLarge, &message.into(), None)
    }

    /// A user-facing validation failure. Unlike `unknown`, the message is
    /// shown verbatim, so it must never contain credentials.
    pub fn invalid(message: impl Into<String>) -> Self {
        let message = message.into();
        Self::new(MailErrorCode::Unknown, &message, None)
    }

    pub fn delete_needs_confirm() -> Self {
        Self::new(
            MailErrorCode::DeleteNeedsConfirm,
            "服务器没有垃圾箱文件夹，此操作将永久删除邮件，是否继续？",
            None,
        )
    }

    /// The credential is already gone but the account config could not be
    /// removed; the user can safely retry.
    pub fn account_delete_failed(detail: impl Into<String>) -> Self {
        Self::new(
            MailErrorCode::Unknown,
            "系统凭据已清除，但删除账号配置失败，请重试删除账号",
            Some(detail.into()),
        )
    }

    pub fn unknown(detail: impl Into<String>) -> Self {
        Self::new(
            MailErrorCode::Unknown,
            "邮件操作失败，请稍后重试",
            Some(detail.into()),
        )
    }

    /// Removes the secret from any error text before it leaves the backend.
    /// Redaction runs on the full (up to 4000 chars) detail first, so a secret
    /// crossing the 600-char display boundary cannot leak a partial fragment.
    pub fn redact(mut self, secret: &str) -> Self {
        if !secret.is_empty() {
            self.message = self.message.replace(secret, "***");
            if let Some(detail) = self.detail.as_mut() {
                *detail = detail.replace(secret, "***");
            }
        }
        self.detail = self
            .detail
            .map(|d| d.chars().take(600).collect::<String>())
            .filter(|d| !d.is_empty());
        self
    }

    pub fn from_imap(err: &imap::Error) -> Self {
        match err {
            imap::Error::Io(e) => Self::from_io(e),
            imap::Error::Tls(e) => Self::tls(Some(e.to_string())),
            imap::Error::TlsHandshake(e) => Self::tls(Some(e.to_string())),
            imap::Error::No(text) | imap::Error::Bad(text) => Self::from_server_text(text),
            imap::Error::ConnectionLost => Self::network(Some("连接被服务器意外关闭".into())),
            imap::Error::Validate(e) => Self::unknown(format!("服务器地址或文件夹名称无效：{e}")),
            imap::Error::Parse(e) => Self::unknown(format!("无法解析服务器响应：{e}")),
            imap::Error::Append => Self::unknown("服务器拒绝了邮件写入请求"),
            _ => Self::unknown("IMAP 操作失败"),
        }
    }

    pub(crate) fn from_io(err: &io::Error) -> Self {
        match err.kind() {
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => Self::timeout(Some(err.to_string())),
            io::ErrorKind::NotFound => {
                Self::network(Some(format!("无法解析邮件服务器地址：{err}")))
            }
            io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::NotConnected
            | io::ErrorKind::AddrNotAvailable
            | io::ErrorKind::BrokenPipe => Self::network(Some(err.to_string())),
            _ => Self::network(Some(err.to_string())),
        }
    }

    fn from_server_text(text: &str) -> Self {
        let lower = text.to_ascii_lowercase();

        if (lower.contains("imap") && (lower.contains("disabled") || lower.contains("not enabled")))
            || lower.contains("imap is not")
            || text.contains("未开启")
            || text.contains("未启用")
        {
            return Self::imap_disabled(Some(text.to_string()));
        }

        // Check credential failures before frequency limits: QQ's rejection
        // text lists "password is incorrect" and "login frequency limited"
        // together, and the user needs the actionable password message.
        if lower.contains("authenticationfailed")
            || lower.contains("authentication failed")
            || lower.contains("login failed")
            || lower.contains("invalid credentials")
            || lower.contains("invalid user")
            || lower.contains("invalid username")
            || lower.contains("invalid password")
            || lower.contains("password is incorrect")
            || lower.contains("username or password")
            // Coremail (163/126) rejects LOGIN with this exact text.
            || lower.contains("login error or password error")
            || lower.contains("password error")
            || lower.contains("login error")
            || lower.contains("认证失败")
            || lower.contains("用户名或密码")
            || lower.contains("auth failed")
            || lower.contains("535")
        {
            return Self::auth(Some(text.to_string()));
        }

        if lower.contains("frequency")
            || lower.contains("too many")
            || lower.contains("too frequent")
            || text.contains("频繁")
        {
            return Self::login_too_frequent(Some(text.to_string()));
        }

        if lower.contains("certificate")
            || lower.contains("unknown ca")
            || lower.contains("handshake")
        {
            return Self::tls(Some(text.to_string()));
        }

        if lower.contains("timeout") || lower.contains("timed out") {
            return Self::timeout(Some(text.to_string()));
        }

        Self::unknown(text.to_string())
    }

    pub fn from_smtp(err: &lettre::transport::smtp::Error) -> Self {
        if err.is_timeout() {
            return Self::timeout(Some(err.to_string()));
        }
        if err.is_tls() {
            return Self::tls(Some(err.to_string()));
        }
        if let Some(code) = err.status() {
            let code_num = u16::from(code);
            if code_num == 530 || code_num == 534 || code_num == 535 {
                return Self::auth(Some(err.to_string()));
            }
            if err.is_permanent() {
                return Self::new(
                    MailErrorCode::Unknown,
                    "邮件服务器拒绝了本次发信请求",
                    Some(format!("{code_num}: {err}")),
                );
            }
            if err.is_transient() {
                return Self::new(
                    MailErrorCode::Network,
                    "邮件服务器暂时不可用，请稍后重试",
                    Some(format!("{code_num}: {err}")),
                );
            }
        }
        Self::network(Some(err.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_common_server_failures() {
        let auth = MailError::from_server_text("[AUTHENTICATIONFAILED] Invalid credentials (Failure)");
        assert_eq!(auth.code, MailErrorCode::AuthFailed);

        let disabled = MailError::from_server_text("IMAP is disabled for this account");
        assert_eq!(disabled.code, MailErrorCode::ImapDisabled);

        let cert = MailError::from_server_text("certificate verify failed");
        assert_eq!(cert.code, MailErrorCode::TlsError);

        let frequent = MailError::from_server_text("login frequency limited, please try later");
        assert_eq!(frequent.code, MailErrorCode::AuthFailed);
        assert!(frequent.message.contains("频繁"));
    }

    #[test]
    fn maps_coremail_login_error_to_auth_failed() {
        let err = MailError::from_server_text("LOGIN Login error or password error");
        assert_eq!(err.code, MailErrorCode::AuthFailed);
        assert!(err.message.contains("授权码"));
        assert!(err.message.contains("IMAP/SMTP"));
    }

    #[test]
    fn prefixes_error_with_protocol_stage() {
        let err = MailError::auth(None).with_stage("收件 IMAP");
        assert!(err.message.starts_with("收件 IMAP："));
        assert!(err.message.contains("授权码"));
    }

    #[test]
    fn redacts_secret_from_detail() {
        let err = MailError::auth(Some("login failed for secret-123".into())).redact("secret-123");
        assert!(!format!("{:?}", err).contains("secret-123"));
    }

    #[test]
    fn redacts_secret_straddling_the_display_limit() {
        let detail = format!("{}{}", "x".repeat(590), "secret-123");
        let err = MailError::auth(Some(detail)).redact("secret-123");
        let detail = err.detail.unwrap_or_default();
        assert!(!detail.contains("secret"));
        assert!(detail.chars().count() <= 600);
    }

    #[test]
    fn serializes_delete_needs_confirm_code() {
        let json = serde_json::to_string(&MailError::delete_needs_confirm()).unwrap();
        assert!(json.contains("\"DELETE_NEEDS_CONFIRM\""));
    }
}
