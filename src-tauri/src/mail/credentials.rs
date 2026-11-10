use crate::mail::error::MailError;

const SERVICE: &str = "com.luma.mail";

fn entry(account_id: &str) -> Result<keyring::Entry, MailError> {
    keyring::Entry::new(SERVICE, account_id)
        .map_err(|e| MailError::unknown(format!("无法访问系统凭据管理器：{e}")))
}

/// Stores the password/authorization code in the OS credential manager.
pub fn set_password(account_id: &str, password: &str) -> Result<(), MailError> {
    entry(account_id)?
        .set_password(password)
        .map_err(|e| MailError::unknown(format!("无法保存凭据到系统凭据管理器：{e}")))
}

pub fn get_password(account_id: &str) -> Result<String, MailError> {
    match entry(account_id)?.get_password() {
        Ok(password) => Ok(password),
        Err(keyring::Error::NoEntry) => Err(MailError::not_found(
            "系统凭据管理器中没有该账号的密码/授权码，请重新添加账号",
        )),
        Err(e) => Err(MailError::unknown(format!(
            "无法读取系统凭据管理器中的密码/授权码：{e}"
        ))),
    }
}

pub fn delete_password(account_id: &str) -> Result<(), MailError> {
    match entry(account_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(MailError::unknown(format!(
            "无法从系统凭据管理器删除凭据：{e}"
        ))),
    }
}
