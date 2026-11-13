use crate::mail::credentials;
use crate::mail::error::MailError;
use crate::mail::imap_client::{self, STARRED_FOLDER};
use crate::mail::models::{
    AccountConfig, AccountTestResult, AttachmentPath, FolderInfo, MailDetail, MailSummary,
    MessagePage, SendRequest,
};
use crate::mail::smtp_client;
use crate::mail::store;
use serde::Serialize;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

async fn blocking<T, F>(f: F) -> Result<T, MailError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, MailError> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(result) => result,
        Err(e) => Err(MailError::unknown(format!("后台任务异常退出：{e}"))),
    }
}

fn validate_config(config: &AccountConfig) -> Result<(), MailError> {
    let email = config.email.trim();
    if email.is_empty() || !email.contains('@') || email.starts_with('@') || email.ends_with('@') {
        return Err(MailError::invalid("请填写正确的邮箱地址"));
    }
    if config.username.trim().is_empty() {
        return Err(MailError::invalid("请填写登录用户名"));
    }
    if config.display_name.trim().is_empty() {
        return Err(MailError::invalid("请填写显示名称"));
    }
    if config.imap.host.trim().is_empty() || config.imap.port == 0 {
        return Err(MailError::invalid(
            "请填写 IMAP 服务器地址和端口",
        ));
    }
    if !config.imap.security.eq_ignore_ascii_case("ssl") {
        return Err(MailError::tls(Some(
            "IMAP 仅支持 SSL/TLS 加密连接".to_string(),
        )));
    }
    if config.smtp.host.trim().is_empty() || config.smtp.port == 0 {
        return Err(MailError::invalid(
            "请填写 SMTP 服务器地址和端口",
        ));
    }
    if !config.smtp.security.eq_ignore_ascii_case("ssl")
        && !config.smtp.security.eq_ignore_ascii_case("starttls")
    {
        return Err(MailError::tls(Some(
            "SMTP 仅支持 SSL/TLS 或 STARTTLS 加密连接".to_string(),
        )));
    }
    if config.provider.trim().is_empty() {
        return Err(MailError::invalid("请选择邮箱服务商"));
    }
    if !crate::mail::provider::is_known_provider(config.provider.trim()) {
        return Err(MailError::invalid("不支持的邮箱服务商"));
    }
    Ok(())
}

fn generate_account_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("acc-{millis}-{}", std::process::id())
}

#[tauri::command]
pub async fn account_list(app: AppHandle) -> Result<Vec<AccountConfig>, MailError> {
    blocking(move || store::load_accounts(&app)).await
}

/// Tests IMAP and SMTP credentials. Both protocols are validated so a success
/// here means the account is immediately usable for receiving and sending.
#[tauri::command]
pub async fn account_test(
    config: AccountConfig,
    password: String,
) -> Result<AccountTestResult, MailError> {
    blocking(move || {
        if password.is_empty() {
            return Err(MailError::auth(None));
        }
        validate_config(&config)?;

        let imap_result: Result<(), MailError> = (|| {
            let session = imap_client::connect(&config, &password)?;
            imap_client::close(session);
            Ok(())
        })();
        imap_result
            .map_err(|e| e.with_stage("收件 IMAP").redact(&password))?;

        smtp_client::test(&config, &password)
            .map_err(|e| e.with_stage("发件 SMTP").redact(&password))?;

        Ok(AccountTestResult {
            imap: true,
            smtp: true,
        })
    })
    .await
}

#[tauri::command]
pub async fn account_save(
    app: AppHandle,
    config: AccountConfig,
    password: String,
) -> Result<AccountConfig, MailError> {
    blocking(move || {
        if password.is_empty() {
            return Err(MailError::auth(None));
        }
        validate_config(&config)?;

        let mut config = config;
        // Re-adding an existing address updates that account and keeps its id,
        // so the credential entry must use the same id.
        if let Ok(accounts) = store::load_accounts(&app) {
            if let Some(existing) = accounts
                .iter()
                .find(|a| a.email.eq_ignore_ascii_case(config.email.trim()))
            {
                config.id = existing.id.clone();
            }
        }
        if config.id.trim().is_empty() {
            config.id = generate_account_id();
        }

        let result = (|| {
            credentials::set_password(&config.id, &password)?;
            match store::upsert_account(&app, config.clone()) {
                Ok(saved) => Ok(saved),
                Err(e) => {
                    let _ = credentials::delete_password(&config.id);
                    Err(e)
                }
            }
        })();

        result.map_err(|e| e.redact(&password))
    })
    .await
}

#[tauri::command]
pub async fn account_delete(app: AppHandle, account_id: String) -> Result<(), MailError> {
    blocking(move || {
        // Clear the credential first. If that fails we keep the account so the
        // user can retry instead of leaving an orphaned secret with no UI entry.
        credentials::delete_password(&account_id)?;
        store::remove_account(&app, &account_id)
            .map(|_| ())
            .map_err(|e| MailError::account_delete_failed(e.message))
    })
    .await
}

#[tauri::command]
pub async fn folder_list(app: AppHandle, account_id: String) -> Result<Vec<FolderInfo>, MailError> {
    blocking(move || {
        let account = store::find_account(&app, &account_id)?;
        let password = credentials::get_password(&account_id)?;
        let result = (|| {
            let mut session = imap_client::connect(&account, &password)?;
            let folders = imap_client::list_folders(&mut session);
            imap_client::close(session);
            folders
        })();
        result.map_err(|e| e.with_stage("加载文件夹").redact(&password))
    })
    .await
}

/// One streamed slice of `message_list`. The first chunk lets the UI replace
/// the skeleton; later chunks append. `done` marks a single-shot result (the
/// starred path) so the caller knows no further chunks follow.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageListChunk {
    pub items: Vec<MailSummary>,
    pub total: u32,
    pub has_more: bool,
    pub done: bool,
}

#[tauri::command]
pub async fn message_list(
    app: AppHandle,
    account_id: String,
    folder: String,
    page: u32,
    page_size: u32,
    on_chunk: Channel<MessageListChunk>,
) -> Result<MessagePage, MailError> {
    blocking(move || {
        let account = store::find_account(&app, &account_id)?;
        let password = credentials::get_password(&account_id)?;
        let result = (|| {
            let mut session = imap_client::connect(&account, &password)?;
            let page = if folder == STARRED_FOLDER {
                let folders = imap_client::list_folders_basic(&mut session)?;
                let page = imap_client::list_starred(
                    &mut session,
                    &folders,
                    page,
                    page_size,
                    // The scan can hit the same malformed FETCH as the inbox;
                    // a fresh session is needed to resync after a parse error.
                    || imap_client::connect(&account, &password),
                );
                if let Ok(page) = &page {
                    let _ = on_chunk.send(MessageListChunk {
                        items: page.items.clone(),
                        total: page.total,
                        has_more: page.has_more,
                        done: true,
                    });
                }
                page
            } else {
                imap_client::list_messages_streamed(
                    &mut session,
                    &folder,
                    page,
                    page_size,
                    // A failed FETCH can leave its tagged response unread; the
                    // retry and per-mail isolation need a fresh session.
                    || imap_client::connect(&account, &password),
                    |items, total| {
                        // A dropped receiver only means the window went away;
                        // the command still returns the full page.
                        let _ = on_chunk.send(MessageListChunk {
                            items,
                            total,
                            has_more: false,
                            done: false,
                        });
                    },
                )
            };
            imap_client::close(session);
            page
        })();
        result.map_err(|e| e.with_stage("加载邮件").redact(&password))
    })
    .await
}

#[tauri::command]
pub async fn message_get(
    app: AppHandle,
    account_id: String,
    folder: String,
    uid: u32,
) -> Result<MailDetail, MailError> {
    blocking(move || {
        let account = store::find_account(&app, &account_id)?;
        let password = credentials::get_password(&account_id)?;
        let result = (|| {
            let mut session = imap_client::connect(&account, &password)?;
            let detail = imap_client::get_message(&mut session, &folder, uid);
            imap_client::close(session);
            detail
        })();
        result.map_err(|e| e.redact(&password))
    })
    .await
}

/// Updates the `\Seen` and/or `\Flagged` flags in a single connection. Both
/// arguments are optional so callers only touch the flag they changed.
#[tauri::command]
pub async fn message_set_flags(
    app: AppHandle,
    account_id: String,
    folder: String,
    uid: u32,
    seen: Option<bool>,
    flagged: Option<bool>,
) -> Result<(), MailError> {
    blocking(move || {
        if seen.is_none() && flagged.is_none() {
            return Err(MailError::invalid("缺少要更新的邮件状态"));
        }
        let account = store::find_account(&app, &account_id)?;
        let password = credentials::get_password(&account_id)?;
        let result: Result<(), MailError> = (|| {
            let mut session = imap_client::connect(&account, &password)?;
            if let Some(value) = seen {
                imap_client::set_flags(&mut session, &folder, uid, "seen", value)?;
            }
            if let Some(value) = flagged {
                imap_client::set_flags(&mut session, &folder, uid, "flagged", value)?;
            }
            imap_client::close(session);
            Ok(())
        })();
        result.map_err(|e| e.redact(&password))
    })
    .await
}

#[tauri::command]
pub async fn message_move(
    app: AppHandle,
    account_id: String,
    folder: String,
    uid: u32,
    target: String,
) -> Result<(), MailError> {
    blocking(move || {
        let account = store::find_account(&app, &account_id)?;
        let password = credentials::get_password(&account_id)?;
        let result = (|| {
            if target.trim().is_empty() {
                return Err(MailError::invalid("缺少目标文件夹"));
            }
            let mut session = imap_client::connect(&account, &password)?;
            let moved = imap_client::move_message(&mut session, &folder, uid, &target);
            imap_client::close(session);
            moved
        })();
        result.map_err(|e| e.redact(&password))
    })
    .await
}

#[tauri::command]
pub async fn message_delete(
    app: AppHandle,
    account_id: String,
    folder: String,
    uid: u32,
    permanent: bool,
) -> Result<(), MailError> {
    blocking(move || {
        let account = store::find_account(&app, &account_id)?;
        let password = credentials::get_password(&account_id)?;
        let result = (|| {
            let mut session = imap_client::connect(&account, &password)?;
            let folders = imap_client::list_folders_basic(&mut session)?;
            let deleted = imap_client::delete_message(&mut session, &folders, &folder, uid, permanent);
            imap_client::close(session);
            deleted
        })();
        result.map_err(|e| e.redact(&password))
    })
    .await
}

#[tauri::command]
pub async fn message_send(
    app: AppHandle,
    account_id: String,
    request: SendRequest,
) -> Result<(), MailError> {
    blocking(move || {
        let account = store::find_account(&app, &account_id)?;
        let password = credentials::get_password(&account_id)?;
        let result: Result<(), MailError> = (|| {
            let raw = smtp_client::send(&account, &password, &request)?;

            // Gmail/QQ/163/Exmail/Aliyun save outgoing mail server side. Only
            // self-hosted servers need an explicit APPEND, otherwise the Sent
            // folder would show duplicates.
            if account.provider == "custom" {
                if let Ok(mut session) = imap_client::connect(&account, &password) {
                    if let Ok(folders) = imap_client::list_folders_basic(&mut session) {
                        let _ = imap_client::append_sent(&mut session, &folders, &raw);
                    }
                    imap_client::close(session);
                }
            }
            Ok(())
        })();
        result.map_err(|e| e.redact(&password))
    })
    .await
}

fn download_directory(app: &AppHandle) -> Result<PathBuf, MailError> {
    app.path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| MailError::unknown(format!("无法定位下载目录：{e}")))
}

#[tauri::command]
pub async fn attachment_save(
    app: AppHandle,
    account_id: String,
    folder: String,
    uid: u32,
    index: u32,
    destination: Option<String>,
) -> Result<AttachmentPath, MailError> {
    blocking(move || {
        let account = store::find_account(&app, &account_id)?;
        let password = credentials::get_password(&account_id)?;
        let directory = match destination {
            Some(path) if !path.trim().is_empty() => PathBuf::from(path),
            _ => download_directory(&app)?,
        };
        let result = (|| {
            let mut session = imap_client::connect(&account, &password)?;
            let saved = imap_client::save_attachment(
                &mut session,
                &folder,
                uid,
                index,
                &directory,
            );
            imap_client::close(session);
            saved
        })();
        result.map_err(|e| e.redact(&password))
    })
    .await
}
