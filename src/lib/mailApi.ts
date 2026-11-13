import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  AccountConfig,
  AccountTestResult,
  AttachmentPath,
  FolderInfo,
  MailDetail,
  MailErrorCode,
  MailErrorPayload,
  MessageListChunk,
  MessagePage,
  SendRequest,
} from '@/types';

export class MailApiError extends Error {
  readonly code: MailErrorCode;
  readonly detail?: string;

  constructor(code: MailErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'MailApiError';
    this.code = code;
    this.detail = detail;
  }
}

const CODE_MESSAGES: Record<MailErrorCode, string> = {
  AUTH_FAILED: '邮箱地址或授权码不正确；163/126/QQ 需要使用网页版设置里生成的客户端授权码，不是登录密码；同时确认已开启 IMAP/SMTP 服务',
  IMAP_DISABLED: '该邮箱尚未开启 IMAP 服务，请先在网页版设置中开启',
  TLS_ERROR: '服务器证书校验失败，无法建立安全连接',
  NETWORK: '无法连接到邮件服务器，请检查网络或服务器地址',
  TIMEOUT: '连接邮件服务器超时，请稍后重试',
  NO_ACCOUNT: '请先添加邮箱账号',
  NOT_FOUND: '未找到对应的邮件或文件夹',
  TOO_LARGE: '文件超出大小限制',
  DELETE_NEEDS_CONFIRM: '服务器没有垃圾箱文件夹，此操作将永久删除邮件，是否继续？',
  UNKNOWN: '邮件操作失败，请稍后重试',
};

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function isMailErrorPayload(value: unknown): value is MailErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MailErrorPayload).code === 'string' &&
    typeof (value as MailErrorPayload).message === 'string'
  );
}

/** Normalizes every backend/transport failure into a human-readable error. */
export function toMailApiError(error: unknown): MailApiError {
  if (error instanceof MailApiError) return error;

  if (isMailErrorPayload(error)) {
    const code = (error.code as MailErrorCode) in CODE_MESSAGES ? error.code : 'UNKNOWN';
    const message = error.message.trim() || CODE_MESSAGES[code as MailErrorCode];
    return new MailApiError(code, message, error.detail);
  }

  if (error instanceof Error) {
    return new MailApiError('UNKNOWN', error.message || CODE_MESSAGES.UNKNOWN);
  }

  if (typeof error === 'string' && error.trim()) {
    return new MailApiError('UNKNOWN', error);
  }

  return new MailApiError('UNKNOWN', CODE_MESSAGES.UNKNOWN);
}

// Only read queries are bounded. Mutating commands (message_send,
// attachment_save, account_test, …) must never be reported as failed after the
// server already applied them, otherwise the user retries and duplicates mail.
const READ_TIMEOUT_MS: Record<string, number> = {
  folder_list: 60_000,
  message_list: 120_000,
  message_get: 60_000,
};

/**
 * Bounds how long the UI waits for a backend read query. The invoke promise may
 * still resolve later; the race result is discarded. `message_list` also keeps
 * streaming chunks on its channel after the timeout, so the caller must
 * invalidate its in-flight sequence when this rejects.
 */
async function withTimeout<T>(timeoutMs: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new MailApiError(
              'TIMEOUT',
              '加载超时：邮件服务器响应过慢，请点击重试',
              `请求超过 ${timeoutMs / 1000} 秒未返回`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new MailApiError('UNKNOWN', '请在 Luma Mail 桌面应用中使用邮箱功能');
  }
  try {
    const pending = invoke<T>(command, args);
    const timeoutMs = READ_TIMEOUT_MS[command];
    return await (timeoutMs === undefined ? pending : withTimeout(timeoutMs, pending));
  } catch (error) {
    throw toMailApiError(error);
  }
}

export const mailApi = {
  listAccounts: () => call<AccountConfig[]>('account_list'),

  testAccount: (config: AccountConfig, password: string) =>
    call<AccountTestResult>('account_test', { config, password }),

  saveAccount: (config: AccountConfig, password: string) =>
    call<AccountConfig>('account_save', { config, password }),

  deleteAccount: (accountId: string) =>
    call<void>('account_delete', { accountId }),

  listFolders: (accountId: string) =>
    call<FolderInfo[]>('folder_list', { accountId }),

  listMessages: (
    accountId: string,
    folder: string,
    page: number,
    pageSize: number,
    onChunk?: (chunk: MessageListChunk) => void,
  ) => {
    // The backend streams each FETCH batch on this channel, so the list can
    // render before the whole page has arrived. The command's return value is
    // still the authoritative page (total/hasMore).
    const channel = new Channel<MessageListChunk>();
    if (onChunk) channel.onmessage = onChunk;
    return call<MessagePage>('message_list', {
      accountId,
      folder,
      page,
      pageSize,
      onChunk: channel,
    });
  },

  getMessage: (accountId: string, folder: string, uid: number) =>
    call<MailDetail>('message_get', { accountId, folder, uid }),

  setFlags: (
    accountId: string,
    folder: string,
    uid: number,
    flags: { seen?: boolean; flagged?: boolean },
  ) => call<void>('message_set_flags', { accountId, folder, uid, ...flags }),

  moveMessage: (accountId: string, folder: string, uid: number, target: string) =>
    call<void>('message_move', { accountId, folder, uid, target }),

  deleteMessage: (accountId: string, folder: string, uid: number, permanent = false) =>
    call<void>('message_delete', { accountId, folder, uid, permanent }),

  sendMessage: (accountId: string, request: SendRequest) =>
    call<void>('message_send', { accountId, request }),

  saveAttachment: (
    accountId: string,
    folder: string,
    uid: number,
    index: number,
    destination?: string,
  ) => call<AttachmentPath>('attachment_save', { accountId, folder, uid, index, destination }),
};
