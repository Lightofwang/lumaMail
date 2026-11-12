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
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};

pub type MailSession = imap::Session<TlsStream<TcpStream>>;

/// Virtual folder used by the UI for starred messages.
pub const STARRED_FOLDER: &str = "__starred__";

const SUMMARY_BYTES: u32 = 24 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
const STARRED_PER_FOLDER: usize = 120;
const STARRED_MAX: usize = 400;

fn parser() -> MessageParser {
    MessageParser::default().with_minimal_headers()
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

    open_session(tls, &account.imap.host, &account.username, password)
}

pub fn close(mut session: MailSession) {
    let _ = session.logout();
}

fn attribute_text(attr: &NameAttribute<'_>) -> String {
    match attr {
        NameAttribute::NoInferiors => "\\Noinferiors".to_string(),
        NameAttribute::NoSelect => "\\Noselect".to_string(),
        NameAttribute::Marked => "\\Marked".to_string(),
        NameAttribute::Unmarked => "\\Unmarked".to_string(),
        NameAttribute::Custom(value) => value.to_string(),
    }
}

fn is_selectable(name: &Name) -> bool {
    !name
        .attributes()
        .iter()
        .any(|a| matches!(a, NameAttribute::NoSelect))
}

pub fn list_folders(session: &mut MailSession) -> Result<Vec<FolderInfo>, MailError> {
    let names = session
        .list(None, Some("*"))
        .map_err(|e| MailError::from_imap(&e))?;

    let mut folders = Vec::new();
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
        let unread = session
            .status(&path, "(UNSEEN)")
            .ok()
            .and_then(|mailbox| mailbox.unseen)
            .unwrap_or(0);

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

pub fn list_messages(
    session: &mut MailSession,
    folder: &str,
    page: u32,
    page_size: u32,
) -> Result<MessagePage, MailError> {
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
    let mut items = fetch_summaries(session, page_uids, folder)?;

    // uid_fetch may return messages out of order; keep the newest-first order
    // produced by the UID sort.
    let order: HashMap<u32, usize> = page_uids
        .iter()
        .enumerate()
        .map(|(index, uid)| (*uid, index))
        .collect();
    items.sort_by_key(|item| order.get(&item.uid).copied().unwrap_or(usize::MAX));

    Ok(MessagePage {
        items,
        total,
        has_more: end < uids.len(),
    })
}

pub fn list_starred(
    session: &mut MailSession,
    folders: &[FolderInfo],
    page: u32,
    page_size: u32,
) -> Result<MessagePage, MailError> {
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

    for folder in scope {
        if session.select(&folder.path).is_err() {
            continue;
        }
        let found = match session.uid_search("FLAGGED") {
            Ok(found) => found,
            Err(_) => continue,
        };
        let mut uids: Vec<u32> = found.into_iter().collect();
        uids.sort_unstable_by(|a, b| b.cmp(a));
        uids.truncate(STARRED_PER_FOLDER);
        if uids.is_empty() {
            continue;
        }

        if let Ok(summaries) = fetch_summaries_with_time(session, &uids, &folder.path) {
            collected.extend(summaries);
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

fn fetch_summaries(
    session: &mut MailSession,
    uids: &[u32],
    folder: &str,
) -> Result<Vec<MailSummary>, MailError> {
    Ok(fetch_summaries_with_time(session, uids, folder)?
        .into_iter()
        .map(|(_, summary)| summary)
        .collect())
}

fn fetch_summaries_with_time(
    session: &mut MailSession,
    uids: &[u32],
    folder: &str,
) -> Result<Vec<(i64, MailSummary)>, MailError> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }

    let set = uids
        .iter()
        .map(|uid| uid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.{SUMMARY_BYTES}> BODYSTRUCTURE)"
    );

    let fetches = session
        .uid_fetch(set, query)
        .map_err(|e| MailError::from_imap(&e))?;

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
