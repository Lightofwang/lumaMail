// Account / server types
export type ProviderId = 'gmail' | '126' | '163' | 'qq' | 'exmail' | 'aliyun' | 'custom';

export type ServerSecurity = 'ssl' | 'starttls';

export interface ServerConfig {
  host: string;
  port: number;
  security: ServerSecurity;
}

/** Account configuration as persisted by the Rust backend (`accounts.json`).
 *  It never carries a password: the secret lives in the OS credential manager. */
export interface AccountConfig {
  id: string;
  provider: ProviderId;
  email: string;
  displayName: string;
  imap: ServerConfig;
  smtp: ServerConfig;
  username: string;
}

export interface Account {
  id: string;
  name: string;
  email: string;
  signature: string;
  provider: ProviderId;
  imap: ServerConfig;
  smtp: ServerConfig;
  username: string;
}

// Folder types
export type FolderType = 'inbox' | 'starred' | 'sent' | 'drafts' | 'archive' | 'trash' | 'junk' | 'custom';

export interface Folder {
  id: string;
  name: string;
  type: FolderType;
  icon: string;
  unreadCount: number;
  accountId: string;
  /** Real IMAP mailbox path, or the virtual starred marker. */
  path: string;
  color?: string;
}

// Attachment
export interface Attachment {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  /** Index passed to `attachment_save` for a real message attachment. */
  downloadIndex?: number;
}

// Message
export interface Message {
  id: string;
  threadId: string;
  accountId: string;
  from: Contact;
  to: Contact[];
  cc: Contact[];
  bcc: Contact[];
  subject: string;
  body: string; // HTML content
  bodyText: string; // Plain text fallback
  timestamp: string; // ISO date
  read: boolean;
  starred: boolean;
  folderId: string;
  /** IMAP mailbox path the message was listed from. */
  folderPath: string;
  /** IMAP UID, used by every message command. */
  uid: number;
  attachments: Attachment[];
  isDraft?: boolean;
  detailLoaded?: boolean;
  detailLoading?: boolean;
  detailError?: string | null;
}

export interface Contact {
  name: string;
  email: string;
}

// Thread (one conversation group per message in this version)
export interface Thread {
  id: string;
  accountId: string;
  folderId: string;
  subject: string;
  messages: Message[];
  lastMessage: Message;
  unreadCount: number;
  isStarred: boolean;
  hasAttachments: boolean;
  participants: Contact[];
}

// Compose draft
export interface ComposeDraft {
  id: string;
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  timestamp: string;
}

// ── Backend command payloads ────────────────────────────────────────────────

export type MailErrorCode =
  | 'AUTH_FAILED'
  | 'IMAP_DISABLED'
  | 'TLS_ERROR'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'NO_ACCOUNT'
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'DELETE_NEEDS_CONFIRM'
  | 'UNKNOWN';

export interface MailErrorPayload {
  code: MailErrorCode;
  message: string;
  detail?: string;
}

export interface FolderInfo {
  name: string;
  path: string;
  kind: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'other';
  unread: number;
}

export interface MailSummary {
  uid: number;
  folder: string;
  subject: string;
  from: Contact;
  to: Contact[];
  date: string;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  preview: string;
  size: number;
}

export interface AttachmentInfo {
  index: number;
  name: string;
  mime: string;
  size: number;
}

export interface MailDetail extends MailSummary {
  cc: Contact[];
  bodyHtml: string;
  bodyText: string;
  attachments: AttachmentInfo[];
}

export interface MessagePage {
  items: MailSummary[];
  total: number;
  hasMore: boolean;
}

export interface AccountTestResult {
  imap: boolean;
  smtp: boolean;
}

export interface SendRequest {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  text: string;
  attachments: { name: string; path: string }[];
}

export interface AttachmentPath {
  name: string;
  path: string;
}

// Settings
export type DensityMode = 'comfortable' | 'compact';

export interface AppSettings {
  density: DensityMode;
  fontSize: number;
}

// Toast
export interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
  duration?: number;
}

// Command palette action
export interface CommandAction {
  id: string;
  label: string;
  description?: string;
  icon: string;
  category: 'navigation' | 'action' | 'settings';
  shortcut?: string;
  action: () => void;
}
