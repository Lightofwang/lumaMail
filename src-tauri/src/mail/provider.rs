use base64::Engine;

/// Provider identifiers understood by the UI. Server parameters live in the
/// frontend presets; the backend only rejects unknown identifiers.
pub fn is_known_provider(provider: &str) -> bool {
    matches!(
        provider,
        "gmail" | "126" | "163" | "qq" | "exmail" | "aliyun" | "custom"
    )
}

/// IMAP folder names are encoded with modified UTF-7 (RFC 3501 5.1.3).
pub fn decode_mailbox_name(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_string();
    }

    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] == b'&' {
            if i + 1 < bytes.len() && bytes[i + 1] == b'-' {
                out.push('&');
                i += 2;
                continue;
            }

            let start = i + 1;
            let mut end = start;
            while end < bytes.len() && bytes[end] != b'-' {
                end += 1;
            }

            if end >= bytes.len() {
                // Unterminated escape: keep it verbatim.
                out.push('&');
                i += 1;
                continue;
            }

            let chunk = &raw[start..end];
            let b64 = chunk.replace(',', "/");
            let padded = match b64.len() % 4 {
                0 => b64,
                2 => format!("{b64}=="),
                3 => format!("{b64}="),
                _ => {
                    out.push_str(&raw[i..=end]);
                    i = end + 1;
                    continue;
                }
            };

            match base64::engine::general_purpose::STANDARD.decode(padded) {
                Ok(decoded) if decoded.len() % 2 == 0 => {
                    let units: Vec<u16> = decoded
                        .chunks_exact(2)
                        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                        .collect();
                    out.push_str(&String::from_utf16_lossy(&units));
                }
                _ => out.push_str(&raw[i..=end]),
            }
            i = end + 1;
            continue;
        }

        let ch = raw[i..].chars().next().unwrap_or('?');
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

fn attr_matches(attrs: &[String], needle: &str) -> bool {
    // Servers may send special-use attributes in any case (\\Trash, \\SENT),
    // while the needles below are lowercase.
    attrs
        .iter()
        .any(|a| a.to_ascii_lowercase().contains(needle))
}

/// Classifies a mailbox using SPECIAL-USE attributes first, then common names
/// used by Gmail, QQ, 126, 163, Exchange and self-hosted servers.
pub fn folder_kind(path: &str, attrs: &[String]) -> &'static str {
    if path.eq_ignore_ascii_case("INBOX") {
        return "inbox";
    }

    let lower = path.to_ascii_lowercase();

    if attr_matches(attrs, "\\trash")
        || lower.contains("trash")
        || lower.contains("deleted")
        || path.contains("已删除")
        || path.contains("废纸篓")
        || path.contains("回收站")
        || path.contains("垃圾箱")
    {
        return "trash";
    }

    if attr_matches(attrs, "\\junk")
        || attr_matches(attrs, "\\spam")
        || lower.contains("junk")
        || lower.contains("spam")
        || path.contains("垃圾邮件")
        || path.contains("广告邮件")
    {
        return "junk";
    }

    if attr_matches(attrs, "\\drafts")
        || lower.contains("draft")
        || path.contains("草稿")
    {
        return "drafts";
    }

    if attr_matches(attrs, "\\sent")
        || lower.contains("sent")
        || path.contains("已发送")
        || path.contains("发件箱")
    {
        return "sent";
    }

    if attr_matches(attrs, "\\archive")
        || attr_matches(attrs, "\\all")
        || lower.contains("archive")
        || lower.contains("all mail")
        || path.contains("归档")
        || path.contains("存档")
    {
        return "archive";
    }

    "other"
}

pub fn folder_display_name(path: &str, kind: &str) -> String {
    match kind {
        "inbox" => "收件箱".to_string(),
        "sent" => "已发送".to_string(),
        "drafts" => "草稿箱".to_string(),
        "trash" => "垃圾箱".to_string(),
        "junk" => "垃圾邮件".to_string(),
        "archive" => "归档".to_string(),
        _ => decode_mailbox_name(path),
    }
}

pub fn folder_sort_rank(kind: &str) -> u8 {
    match kind {
        "inbox" => 0,
        "sent" => 1,
        "drafts" => 2,
        "archive" => 3,
        "trash" => 4,
        "junk" => 5,
        _ => 6,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_modified_utf7() {
        assert_eq!(decode_mailbox_name("INBOX"), "INBOX");
        assert_eq!(decode_mailbox_name("&XfJT0ZAB-"), "已发送");
        assert_eq!(decode_mailbox_name("A&-B"), "A&B");
    }

    #[test]
    fn classifies_common_folders() {
        assert_eq!(folder_kind("INBOX", &[]), "inbox");
        assert_eq!(folder_kind("[Gmail]/Sent Mail", &[]), "sent");
        assert_eq!(folder_kind("[Gmail]/All Mail", &[]), "archive");
        assert_eq!(folder_kind("已删除", &[]), "trash");
        assert_eq!(folder_kind("草稿箱", &[]), "drafts");
        assert_eq!(folder_kind("Junk", &[]), "junk");
        assert_eq!(folder_kind("Projects", &[]), "other");
    }

    #[test]
    fn classifies_uppercase_special_use_attributes() {
        assert_eq!(folder_kind("Trash", &["\\Trash".to_string()]), "trash");
        assert_eq!(folder_kind("Sent Items", &["\\Sent".to_string()]), "sent");
        assert_eq!(folder_kind("All", &["\\All".to_string()]), "archive");
        assert_eq!(folder_kind("Drafts", &["\\DRAFTS".to_string()]), "drafts");
    }
}
