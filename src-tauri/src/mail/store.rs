use crate::mail::error::MailError;
use crate::mail::models::{AccountConfig, AccountsFile};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "accounts.json";

pub fn accounts_path(app: &AppHandle) -> Result<PathBuf, MailError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| MailError::unknown(format!("无法定位应用数据目录：{e}")))?;
    fs::create_dir_all(&dir)
        .map_err(|e| MailError::unknown(format!("无法创建应用数据目录：{e}")))?;
    Ok(dir.join(FILE_NAME))
}

pub fn load_accounts(app: &AppHandle) -> Result<Vec<AccountConfig>, MailError> {
    load_accounts_from_file(&accounts_path(app)?)
}

fn load_accounts_from_file(path: &PathBuf) -> Result<Vec<AccountConfig>, MailError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path)
        .map_err(|e| MailError::unknown(format!("无法读取账号配置：{e}")))?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Accept both the versioned object and a bare array (hand-edited files).
    if let Ok(file) = serde_json::from_str::<AccountsFile>(&raw) {
        return Ok(file.accounts);
    }
    if let Ok(accounts) = serde_json::from_str::<Vec<AccountConfig>>(&raw) {
        return Ok(accounts);
    }

    Err(MailError::unknown("账号配置文件格式损坏，无法读取"))
}

pub fn save_accounts(app: &AppHandle, accounts: &[AccountConfig]) -> Result<(), MailError> {
    let path = accounts_path(app)?;
    let payload = AccountsFile {
        version: 1,
        accounts: accounts.to_vec(),
    };
    let json = serde_json::to_string_pretty(&payload)
        .map_err(|e| MailError::unknown(format!("无法序列化账号配置：{e}")))?;

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| MailError::unknown(format!("无法写入账号配置：{e}")))?;

    if fs::rename(&tmp, &path).is_err() {
        // Windows cannot atomically replace an existing file. Fall back to a
        // copy, then remove the temporary file.
        fs::copy(&tmp, &path).map_err(|e| MailError::unknown(format!("无法保存账号配置：{e}")))?;
        let _ = fs::remove_file(&tmp);
    }
    Ok(())
}

pub fn find_account(app: &AppHandle, account_id: &str) -> Result<AccountConfig, MailError> {
    load_accounts(app)?
        .into_iter()
        .find(|a| a.id == account_id)
        .ok_or_else(MailError::no_account)
}

pub fn upsert_account(
    app: &AppHandle,
    mut config: AccountConfig,
) -> Result<AccountConfig, MailError> {
    let mut accounts = load_accounts(app)?;

    if let Some(existing) = accounts.iter_mut().find(|a| a.email.eq_ignore_ascii_case(&config.email)) {
        // Re-adding the same address updates the existing entry instead of
        // creating a duplicate.
        config.id = existing.id.clone();
        *existing = config.clone();
    } else if let Some(existing) = accounts.iter_mut().find(|a| a.id == config.id) {
        *existing = config.clone();
    } else {
        accounts.push(config.clone());
    }

    save_accounts(app, &accounts)?;
    Ok(config)
}

pub fn remove_account(app: &AppHandle, account_id: &str) -> Result<Option<AccountConfig>, MailError> {
    let mut accounts = load_accounts(app)?;
    let removed = accounts
        .iter()
        .position(|a| a.id == account_id)
        .map(|index| accounts.remove(index));

    if removed.is_some() {
        save_accounts(app, &accounts)?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::models::ServerConfig;

    #[test]
    fn account_file_never_contains_credentials() {
        let account = AccountConfig {
            id: "acc-1".into(),
            provider: "qq".into(),
            email: "user@qq.com".into(),
            display_name: "User".into(),
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
            username: "user@qq.com".into(),
        };
        let file = AccountsFile {
            version: 1,
            accounts: vec![account],
        };
        let raw = serde_json::to_string(&file).unwrap();
        assert!(!raw.to_ascii_lowercase().contains("password"));
        assert!(!raw.to_ascii_lowercase().contains("secret"));
        assert!(!raw.to_ascii_lowercase().contains("authcode"));
    }
}
