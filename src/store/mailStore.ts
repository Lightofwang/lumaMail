import { create } from 'zustand';
import type {
  Account,
  AccountConfig,
  AppSettings,
  Attachment,
  ComposeDraft,
  Contact,
  DensityMode,
  Folder,
  FolderInfo,
  MailDetail,
  MailSummary,
  Message,
  Thread,
  Toast,
} from '@/types';
import { isTauriRuntime, mailApi, toMailApiError } from '@/lib/mailApi';
import { getAvatarGradient } from '@/lib/utils';

const PAGE_SIZE = 30;
const STARRED_PATH = '__starred__';
const DRAFT_THREAD_PREFIX = 'thread-draft-';

interface MailState {
  // Data — loaded from the Rust backend on startup
  accounts: Account[];
  folders: Folder[];
  threads: Thread[];
  allMessages: Message[];
  drafts: ComposeDraft[];

  // UI state
  currentAccountId: string;
  currentFolderId: string;
  selectedThreadId: string | null;
  sidebarCollapsed: boolean;
  searchQuery: string;
  searchFilter: 'all' | 'unread' | 'attachments';
  isComposing: boolean;
  composeDraft: Partial<Message> | null;
  isSettingsOpen: boolean;
  isCommandPaletteOpen: boolean;
  isAccountFormOpen: boolean;
  toasts: Toast[];
  isLoading: boolean;
  isInitialized: boolean;
  folderLoading: boolean;
  loadingMore: boolean;
  folderError: string | null;
  page: number;
  hasMore: boolean;

  // Settings
  settings: AppSettings;

  // Actions
  bootstrap: () => Promise<void>;
  addAccount: (config: AccountConfig, password: string) => Promise<Account>;
  removeAccount: (accountId: string) => Promise<void>;
  refreshFolders: () => Promise<void>;
  loadMessages: (reset?: boolean) => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  loadThreadDetail: (threadId: string) => Promise<void>;
  retryThreadDetail: (threadId: string) => void;
  saveAttachment: (thread: Thread, attachment: Attachment) => Promise<void>;
  setCurrentAccount: (accountId: string) => Promise<void>;
  setCurrentFolder: (folderId: string) => Promise<void>;
  selectThread: (threadId: string | null) => void;
  toggleSidebar: () => void;
  setSearchQuery: (query: string) => void;
  setSearchFilter: (filter: 'all' | 'unread' | 'attachments') => void;
  openCompose: (draft?: Partial<Message>) => void;
  closeCompose: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  openAccountForm: () => void;
  closeAccountForm: () => void;
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
  markThreadRead: (threadId: string) => Promise<void>;
  toggleStarThread: (threadId: string) => Promise<void>;
  archiveThread: (threadId: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  sendMessage: (message: Partial<Message>) => Promise<boolean>;
  saveDraft: (draft: ComposeDraft) => void;
  deleteDraft: (draftId: string) => void;
  setDensity: (density: DensityMode) => void;
  setFontSize: (size: number) => void;
  setLoading: (loading: boolean) => void;
  clearLocalData: () => Promise<void>;

  // Computed helpers
  getFilteredThreads: () => Thread[];
  getThreadById: (threadId: string) => Thread | undefined;
  getCurrentFolders: () => Folder[];
  getUnreadCount: (folderId: string) => number;
}

// ── Persistence v3 ──────────────────────────────────────────────────────────
// Only UI preferences, the selected account id and local drafts are persisted.
// Accounts, folders, messages and credentials never touch localStorage.

interface PersistedStateV3 {
  drafts: ComposeDraft[];
  density: DensityMode;
  fontSize: number;
  sidebarCollapsed: boolean;
  selectedAccountId: string;
}

const PERSIST_KEY_V3 = 'luma-mail-state-v3';
const LEGACY_PERSIST_KEYS = ['luma-mail-state-v2', 'luma-mail-state'];

function cleanupLegacyStorage() {
  try {
    for (const key of LEGACY_PERSIST_KEYS) {
      localStorage.removeItem(key);
    }
  } catch { /* storage unavailable */ }
}

function getDefaultPersistedState(): PersistedStateV3 {
  return {
    drafts: [],
    density: 'comfortable',
    fontSize: 14,
    sidebarCollapsed: false,
    selectedAccountId: '',
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sanitizeDrafts(value: unknown): ComposeDraft[] {
  if (!Array.isArray(value)) return [];
  const drafts: ComposeDraft[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    if (typeof item.id === 'string' && typeof item.accountId === 'string') {
      drafts.push(item as unknown as ComposeDraft);
    }
  }
  return drafts;
}

function loadPersistedState(): PersistedStateV3 {
  try {
    const saved = localStorage.getItem(PERSIST_KEY_V3);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (isObject(parsed)) {
        return {
          drafts: sanitizeDrafts(parsed.drafts),
          density: parsed.density === 'compact' ? 'compact' : 'comfortable',
          fontSize: typeof parsed.fontSize === 'number' ? parsed.fontSize : 14,
          sidebarCollapsed: parsed.sidebarCollapsed === true,
          selectedAccountId: typeof parsed.selectedAccountId === 'string' ? parsed.selectedAccountId : '',
        };
      }
    }
  } catch { /* corrupted or unavailable storage — fall back to empty state */ }
  return getDefaultPersistedState();
}

function savePersistedState(state: PersistedStateV3) {
  try {
    localStorage.setItem(PERSIST_KEY_V3, JSON.stringify(state));
  } catch { /* ignore */ }
}

function persistFullState(state: MailState) {
  savePersistedState({
    drafts: state.drafts,
    density: state.settings.density,
    fontSize: state.settings.fontSize,
    sidebarCollapsed: state.sidebarCollapsed,
    selectedAccountId: state.currentAccountId,
  });
}

cleanupLegacyStorage();
const persisted = loadPersistedState();

// ── Adapters (backend payloads → existing Thread/Message shapes) ────────────

function folderId(accountId: string, path: string): string {
  return `${accountId}::${path}`;
}

function folderIcon(kind: Folder['type']): string {
  switch (kind) {
    case 'inbox': return 'inbox';
    case 'starred': return 'star';
    case 'sent': return 'send';
    case 'drafts': return 'file-text';
    case 'archive': return 'archive';
    case 'trash': return 'trash-2';
    case 'junk': return 'junk';
    default: return 'folder';
  }
}

function adaptFolders(accountId: string, infos: FolderInfo[]): Folder[] {
  const folders: Folder[] = infos.map(info => {
    const type: Folder['type'] = info.kind === 'other' ? 'custom' : info.kind;
    return {
      id: folderId(accountId, info.path),
      name: info.name,
      type,
      icon: folderIcon(type),
      unreadCount: Number.isFinite(info.unread) ? info.unread : 0,
      accountId,
      path: info.path,
    };
  });

  const starred: Folder = {
    id: folderId(accountId, STARRED_PATH),
    name: '星标',
    type: 'starred',
    icon: 'star',
    unreadCount: 0,
    accountId,
    path: STARRED_PATH,
  };
  const inboxIndex = folders.findIndex(f => f.type === 'inbox');
  folders.splice(inboxIndex >= 0 ? inboxIndex + 1 : 0, 0, starred);
  return folders;
}

function normalizeDate(value: string): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function threadIdFor(folderPath: string, uid: number): string {
  return `${encodeURIComponent(folderPath)}#${uid}`;
}

function adaptSummary(summary: MailSummary, accountId: string, folder: Folder): Thread {
  const id = threadIdFor(summary.folder, summary.uid);
  const message: Message = {
    id,
    threadId: id,
    accountId,
    from: summary.from,
    to: summary.to,
    cc: [],
    bcc: [],
    subject: summary.subject || '(无主题)',
    body: '',
    bodyText: summary.preview,
    timestamp: normalizeDate(summary.date),
    read: summary.seen,
    starred: summary.flagged,
    folderId: folder.id,
    folderPath: summary.folder,
    uid: summary.uid,
    attachments: [],
    detailLoaded: false,
  };

  return {
    id,
    accountId,
    folderId: folder.id,
    subject: message.subject,
    messages: [message],
    lastMessage: message,
    unreadCount: summary.seen ? 0 : 1,
    isStarred: summary.flagged,
    hasAttachments: summary.hasAttachments,
    participants: [summary.from, ...summary.to],
  };
}

function applyDetail(thread: Thread, detail: MailDetail): Thread {
  const previous = thread.lastMessage;
  const message: Message = {
    ...previous,
    from: detail.from,
    to: detail.to,
    cc: detail.cc,
    subject: detail.subject || previous.subject,
    body: detail.bodyHtml || '',
    bodyText: detail.bodyText || previous.bodyText,
    timestamp: normalizeDate(detail.date),
    read: true,
    starred: detail.flagged,
    attachments: detail.attachments.map(att => ({
      id: `${thread.id}-att-${att.index}`,
      filename: att.name,
      size: att.size,
      mimeType: att.mime,
      downloadIndex: att.index,
    })),
    detailLoaded: true,
    detailLoading: false,
    detailError: null,
  };

  return {
    ...thread,
    subject: message.subject,
    messages: [message],
    lastMessage: message,
    unreadCount: 0,
    isStarred: message.starred,
    hasAttachments: detail.attachments.length > 0 || detail.hasAttachments,
    participants: [message.from, ...message.to],
  };
}

function adaptDraft(draft: ComposeDraft, account: Account, folder: Folder): Thread {
  const threadIdValue = DRAFT_THREAD_PREFIX + draft.id;
  const message: Message = {
    id: threadIdValue,
    threadId: threadIdValue,
    accountId: draft.accountId,
    from: { name: account.name, email: account.email },
    to: splitContacts(draft.to),
    cc: splitContacts(draft.cc),
    bcc: splitContacts(draft.bcc),
    subject: draft.subject || '(无主题)',
    body: draft.body || '',
    bodyText: (draft.body || '').replace(/<[^>]*>/g, ''),
    timestamp: normalizeDate(draft.timestamp),
    read: true,
    starred: false,
    folderId: folder.id,
    folderPath: folder.path,
    uid: 0,
    attachments: [],
    isDraft: true,
    detailLoaded: true,
  };

  return {
    id: threadIdValue,
    accountId: draft.accountId,
    folderId: folder.id,
    subject: message.subject,
    messages: [message],
    lastMessage: message,
    unreadCount: 0,
    isStarred: false,
    hasAttachments: false,
    participants: [message.from, ...message.to],
  };
}

function splitContacts(raw: string): Contact[] {
  return raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => ({ name: value, email: value }));
}

function adaptAccount(config: AccountConfig): Account {
  return {
    id: config.id,
    name: config.displayName || config.email,
    email: config.email,
    avatarColors: getAvatarGradient(config.email),
    signature: '',
    provider: config.provider,
    imap: config.imap,
    smtp: config.smtp,
    username: config.username,
  };
}

function collectMessages(threads: Thread[]): Message[] {
  const byId = new Map<string, Message>();
  for (const thread of threads) {
    for (const message of thread.messages) {
      if (!byId.has(message.id)) byId.set(message.id, message);
    }
  }
  return Array.from(byId.values());
}

function updateThread(
  threads: Thread[],
  threadIdValue: string,
  updater: (thread: Thread) => Thread,
): Thread[] {
  return threads.map(thread => (thread.id === threadIdValue ? updater(thread) : thread));
}

function mapThreadMessages(thread: Thread, updater: (message: Message) => Message): Thread {
  const messages = thread.messages.map(updater);
  const lastMessage = messages[messages.length - 1] ?? thread.lastMessage;
  return {
    ...thread,
    messages,
    lastMessage,
    unreadCount: messages.some(m => !m.read) ? thread.unreadCount : 0,
    isStarred: lastMessage.starred,
    hasAttachments: messages.some(m => m.attachments.length > 0) || thread.hasAttachments,
  };
}

function adjustUnread(folders: Folder[], folderIdValue: string, delta: number): Folder[] {
  return folders.map(folder => {
    if (folder.id !== folderIdValue) return folder;
    return { ...folder, unreadCount: Math.max(0, folder.unreadCount + delta) };
  });
}

function currentDraftThreads(state: MailState): Thread[] {
  const folder = state.folders.find(f => f.id === state.currentFolderId);
  if (!folder || folder.type !== 'drafts') return [];
  const account = state.accounts.find(a => a.id === state.currentAccountId);
  if (!account) return [];
  return state.drafts
    .filter(draft => draft.accountId === state.currentAccountId)
    .map(draft => adaptDraft(draft, account, folder));
}

// ── Store ───────────────────────────────────────────────────────────────────

let loadSequence = 0;
let bootstrapPromise: Promise<void> | null = null;

export const useMailStore = create<MailState>((set, get) => ({
  // Data
  accounts: [],
  folders: [],
  threads: [],
  allMessages: [],
  drafts: persisted.drafts,

  // UI state
  currentAccountId: '',
  currentFolderId: '',
  selectedThreadId: null,
  sidebarCollapsed: persisted.sidebarCollapsed,
  searchQuery: '',
  searchFilter: 'all',
  isComposing: false,
  composeDraft: null,
  isSettingsOpen: false,
  isCommandPaletteOpen: false,
  isAccountFormOpen: false,
  toasts: [],
  isLoading: false,
  isInitialized: false,
  folderLoading: false,
  loadingMore: false,
  folderError: null,
  page: 0,
  hasMore: true,

  // Settings
  settings: {
    density: persisted.density,
    fontSize: persisted.fontSize,
  },

  bootstrap: async () => {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      set({ isLoading: true });
      try {
        if (!isTauriRuntime()) {
          set({ isInitialized: true });
          return;
        }
        const configs = await mailApi.listAccounts();
        const accounts = configs.map(adaptAccount);
        set({ accounts });

        const preferred = accounts.find(a => a.id === persisted.selectedAccountId);
        const target = preferred ?? accounts[0];
        if (target) {
          await get().setCurrentAccount(target.id);
        }
      } catch (error) {
        const mailError = toMailApiError(error);
        get().addToast({ message: mailError.message, type: 'error' });
      } finally {
        set({ isLoading: false, isInitialized: true });
      }
    })();
    return bootstrapPromise;
  },

  addAccount: async (config, password) => {
    await mailApi.testAccount(config, password);
    const saved = await mailApi.saveAccount(config, password);
    const account = adaptAccount(saved);
    set(state => {
      const others = state.accounts.filter(
        a => a.id !== account.id && a.email.toLowerCase() !== account.email.toLowerCase(),
      );
      return { accounts: [...others, account] };
    });
    await get().setCurrentAccount(account.id);
    get().addToast({ message: '账号已添加，正在同步邮件', type: 'success' });
    return account;
  },

  removeAccount: async (accountId) => {
    await mailApi.deleteAccount(accountId);
    const state = get();
    const remaining = state.accounts.filter(a => a.id !== accountId);
    set({
      accounts: remaining,
      drafts: state.drafts.filter(d => d.accountId !== accountId),
    });

    if (state.currentAccountId !== accountId) {
      persistFullState(get());
      return;
    }

    set({
      currentAccountId: '',
      currentFolderId: '',
      selectedThreadId: null,
      folders: [],
      threads: [],
      allMessages: [],
      folderError: null,
    });
    if (remaining[0]) {
      await get().setCurrentAccount(remaining[0].id);
    } else {
      persistFullState(get());
    }
    get().addToast({ message: '账号已删除', type: 'success' });
  },

  refreshFolders: async () => {
    const accountId = get().currentAccountId;
    if (!accountId) return;
    try {
      const infos = await mailApi.listFolders(accountId);
      if (get().currentAccountId !== accountId) return;
      const folders = adaptFolders(accountId, infos);
      const stillExists = folders.some(f => f.id === get().currentFolderId);
      set({
        folders,
        currentFolderId: stillExists ? get().currentFolderId : '',
        folderError: null,
      });
      if (!stillExists) {
        const defaultFolder = folders.find(f => f.type === 'inbox') ?? folders[0];
        if (defaultFolder) {
          await get().setCurrentFolder(defaultFolder.id);
        }
      }
    } catch (error) {
      const mailError = toMailApiError(error);
      if (get().currentAccountId !== accountId) return;
      set({ folderError: mailError.message });
      get().addToast({ message: mailError.message, type: 'error' });
    }
  },

  loadMessages: async (reset = false) => {
    const state = get();
    const { currentAccountId, currentFolderId, folders } = state;
    const folder = folders.find(f => f.id === currentFolderId);
    if (!currentAccountId || !folder) return;

    const nextPage = reset ? 1 : state.page + 1;
    if (!reset && (!state.hasMore || state.loadingMore)) return;

    const sequence = reset ? ++loadSequence : loadSequence;
    set({
      folderLoading: reset,
      loadingMore: !reset,
      ...(reset
        ? {
            threads: [],
            allMessages: [],
            selectedThreadId: null,
            page: 0,
            hasMore: true,
            folderError: null,
          }
        : {}),
    });

    try {
      const result = await mailApi.listMessages(currentAccountId, folder.path, nextPage, PAGE_SIZE);
      if (get().currentAccountId !== currentAccountId || sequence !== loadSequence) return;

      const adapted = result.items.map(item => adaptSummary(item, currentAccountId, folder));
      const current = get();
      const existing = new Set(current.threads.map(thread => thread.id));
      const appended = reset
        ? adapted
        : adapted.filter(thread => !existing.has(thread.id));
      const threads = reset ? adapted : [...current.threads, ...appended];
      set({
        threads,
        allMessages: collectMessages(threads),
        page: nextPage,
        hasMore: result.hasMore,
        folderLoading: false,
        loadingMore: false,
        folderError: null,
      });
    } catch (error) {
      if (get().currentAccountId !== currentAccountId || sequence !== loadSequence) return;
      const mailError = toMailApiError(error);
      set({ folderLoading: false, loadingMore: false, folderError: mailError.message });
    }
  },

  loadMoreMessages: async () => {
    await get().loadMessages(false);
  },

  loadThreadDetail: async (threadIdValue) => {
    const thread = get().threads.find(t => t.id === threadIdValue);
    if (!thread) return;
    const message = thread.lastMessage;
    if (message.isDraft || message.detailLoaded || message.detailLoading) return;

    set(current => ({
      threads: updateThread(current.threads, threadIdValue, t =>
        mapThreadMessages(t, m => ({ ...m, detailLoading: true, detailError: null })),
      ),
    }));

    try {
      const detail = await mailApi.getMessage(
        thread.accountId,
        message.folderPath,
        message.uid,
      );
      set(current => {
        const threads = updateThread(current.threads, threadIdValue, t => applyDetail(t, detail));
        return { threads, allMessages: collectMessages(threads) };
      });
    } catch (error) {
      const mailError = toMailApiError(error);
      set(current => ({
        threads: updateThread(current.threads, threadIdValue, t =>
          mapThreadMessages(t, m => ({
            ...m,
            detailLoading: false,
            detailError: mailError.message,
          })),
        ),
      }));
    }
  },

  retryThreadDetail: (threadIdValue) => {
    set(state => ({
      threads: updateThread(state.threads, threadIdValue, t =>
        mapThreadMessages(t, m => ({ ...m, detailLoaded: false, detailError: null })),
      ),
    }));
    void get().loadThreadDetail(threadIdValue);
  },

  saveAttachment: async (thread, attachment) => {
    const message = thread.lastMessage;
    if (attachment.downloadIndex === undefined || !message.uid) {
      get().addToast({ message: '该附件无法下载', type: 'error' });
      return;
    }
    try {
      const saved = await mailApi.saveAttachment(
        thread.accountId,
        message.folderPath,
        message.uid,
        attachment.downloadIndex,
      );
      get().addToast({ message: `附件已保存：${saved.path}`, type: 'success' });
    } catch (error) {
      const mailError = toMailApiError(error);
      get().addToast({ message: mailError.message, type: 'error' });
    }
  },

  setCurrentAccount: async (accountId) => {
    if (!get().accounts.some(a => a.id === accountId)) return;

    set({
      currentAccountId: accountId,
      currentFolderId: '',
      selectedThreadId: null,
      folders: [],
      threads: [],
      allMessages: [],
      searchQuery: '',
      searchFilter: 'all',
      page: 0,
      hasMore: true,
      folderError: null,
    });
    persistFullState(get());

    try {
      const infos = await mailApi.listFolders(accountId);
      if (get().currentAccountId !== accountId) return;
      const folders = adaptFolders(accountId, infos);
      set({ folders });
      const defaultFolder = folders.find(f => f.type === 'inbox') ?? folders[0];
      if (defaultFolder) {
        await get().setCurrentFolder(defaultFolder.id);
      }
    } catch (error) {
      const mailError = toMailApiError(error);
      if (get().currentAccountId !== accountId) return;
      set({ folderError: mailError.message });
      get().addToast({ message: mailError.message, type: 'error' });
    }
  },

  setCurrentFolder: async (folderIdValue) => {
    const folder = get().folders.find(f => f.id === folderIdValue);
    if (!folder) return;
    set({
      currentFolderId: folderIdValue,
      selectedThreadId: null,
      searchQuery: '',
      searchFilter: 'all',
      threads: [],
      allMessages: [],
      page: 0,
      hasMore: true,
      folderError: null,
      folderLoading: true,
    });
    await get().loadMessages(true);
  },

  selectThread: (threadIdValue) => {
    set({ selectedThreadId: threadIdValue });
    if (!threadIdValue) return;
    const thread = get().threads.find(t => t.id === threadIdValue);
    if (!thread) return;
    if (!thread.lastMessage.read) {
      void get().markThreadRead(threadIdValue);
    }
    if (!thread.lastMessage.detailLoaded) {
      void get().loadThreadDetail(threadIdValue);
    }
  },

  toggleSidebar: () => {
    set(state => ({ sidebarCollapsed: !state.sidebarCollapsed }));
    persistFullState(get());
  },

  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchFilter: (filter) => set({ searchFilter: filter }),

  openCompose: (draft) => set({ isComposing: true, composeDraft: draft || null }),
  closeCompose: () => set({ isComposing: false, composeDraft: null }),

  openSettings: () => set({ isSettingsOpen: true, isAccountFormOpen: false }),
  closeSettings: () => set({ isSettingsOpen: false }),

  openCommandPalette: () => set({ isCommandPaletteOpen: true }),
  closeCommandPalette: () => set({ isCommandPaletteOpen: false }),

  openAccountForm: () => set({
    isAccountFormOpen: true,
    isSettingsOpen: false,
    isComposing: false,
    composeDraft: null,
    isCommandPaletteOpen: false,
  }),
  closeAccountForm: () => set({ isAccountFormOpen: false }),

  addToast: (toast) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const newToast = { ...toast, id };
    set(state => ({ toasts: [...state.toasts, newToast] }));
    setTimeout(() => get().removeToast(id), toast.duration || 3000);
  },

  removeToast: (id) => set(state => ({ toasts: state.toasts.filter(t => t.id !== id) })),

  markThreadRead: async (threadIdValue) => {
    const thread = get().threads.find(t => t.id === threadIdValue);
    if (!thread || thread.lastMessage.isDraft || thread.lastMessage.read) return;
    const message = thread.lastMessage;
    // Resolve the real folder that holds the message (the list may be the
    // virtual starred folder), so unread badges stay accurate.
    const sourceFolderId = get().folders.find(
      f => f.accountId === thread.accountId && f.path === message.folderPath,
    )?.id ?? get().currentFolderId;

    set(current => ({
      threads: updateThread(current.threads, threadIdValue, t => ({
        ...mapThreadMessages(t, m => ({ ...m, read: true })),
        unreadCount: 0,
      })),
      folders: adjustUnread(current.folders, sourceFolderId, -1),
    }));

    try {
      await mailApi.setFlags(thread.accountId, message.folderPath, message.uid, { seen: true });
    } catch (error) {
      set(current => ({
        threads: updateThread(current.threads, threadIdValue, t => ({
          ...mapThreadMessages(t, m => ({ ...m, read: false })),
          unreadCount: 1,
        })),
        folders: adjustUnread(current.folders, sourceFolderId, 1),
      }));
      const mailError = toMailApiError(error);
      get().addToast({ message: mailError.message, type: 'error' });
    }
  },

  toggleStarThread: async (threadIdValue) => {
    const thread = get().threads.find(t => t.id === threadIdValue);
    if (!thread) return;
    const message = thread.lastMessage;
    if (message.isDraft || !message.uid) return;

    const nextStarred = !thread.isStarred;
    set(current => ({
      threads: updateThread(current.threads, threadIdValue, t => ({
        ...t,
        isStarred: nextStarred,
        messages: t.messages.map(m => ({ ...m, starred: nextStarred })),
        lastMessage: { ...t.lastMessage, starred: nextStarred },
      })),
    }));

    try {
      await mailApi.setFlags(thread.accountId, message.folderPath, message.uid, {
        flagged: nextStarred,
      });
      const currentFolder = get().folders.find(f => f.id === get().currentFolderId);
      if (currentFolder?.type === 'starred' && !nextStarred) {
        set(current => {
          const threads = current.threads.filter(t => t.id !== threadIdValue);
          return {
            threads,
            allMessages: collectMessages(threads),
            selectedThreadId:
              current.selectedThreadId === threadIdValue ? null : current.selectedThreadId,
          };
        });
      }
    } catch (error) {
      set(current => ({
        threads: updateThread(current.threads, threadIdValue, t => ({
          ...t,
          isStarred: !nextStarred,
          messages: t.messages.map(m => ({ ...m, starred: !nextStarred })),
          lastMessage: { ...t.lastMessage, starred: !nextStarred },
        })),
      }));
      const mailError = toMailApiError(error);
      get().addToast({ message: mailError.message, type: 'error' });
    }
  },

  archiveThread: async (threadIdValue) => {
    const thread = get().threads.find(t => t.id === threadIdValue);
    if (!thread) return;
    const message = thread.lastMessage;
    if (message.isDraft) {
      get().addToast({ message: '草稿不能归档', type: 'warning' });
      return;
    }
    const archive = get().folders.find(
      f => f.accountId === thread.accountId && f.type === 'archive',
    );
    if (!archive) {
      get().addToast({ message: '该账号没有归档文件夹', type: 'warning' });
      return;
    }
    if (message.folderPath === archive.path) {
      get().addToast({ message: '邮件已在归档中', type: 'info' });
      return;
    }
    const sourceFolderId = get().folders.find(
      f => f.accountId === thread.accountId && f.path === message.folderPath,
    )?.id ?? get().currentFolderId;

    try {
      await mailApi.moveMessage(thread.accountId, message.folderPath, message.uid, archive.path);
      set(current => {
        const threads = current.threads.filter(t => t.id !== threadIdValue);
        return {
          threads,
          allMessages: collectMessages(threads),
          selectedThreadId:
            current.selectedThreadId === threadIdValue ? null : current.selectedThreadId,
          folders: adjustUnread(current.folders, sourceFolderId, message.read ? 0 : -1),
        };
      });
      get().addToast({ message: '邮件已归档', type: 'success' });
    } catch (error) {
      const mailError = toMailApiError(error);
      get().addToast({ message: mailError.message, type: 'error' });
    }
  },

  deleteThread: async (threadIdValue) => {
    const state = get();
    const thread = state.threads.find(t => t.id === threadIdValue)
      ?? currentDraftThreads(state).find(t => t.id === threadIdValue);
    if (!thread) return;
    const message = thread.lastMessage;

    if (message.isDraft && !message.uid) {
      get().deleteDraft(threadIdValue.replace(DRAFT_THREAD_PREFIX, ''));
      get().addToast({ message: '草稿已删除', type: 'info' });
      return;
    }

    const sourceFolderId = get().folders.find(
      f => f.accountId === thread.accountId && f.path === message.folderPath,
    )?.id ?? get().currentFolderId;

    const removeFromList = (permanently: boolean) => {
      const snapshot = get();
      const inTrash =
        snapshot.folders.find(f => f.id === snapshot.currentFolderId)?.type === 'trash';
      set(current => {
        const threads = current.threads.filter(t => t.id !== threadIdValue);
        return {
          threads,
          allMessages: collectMessages(threads),
          selectedThreadId:
            current.selectedThreadId === threadIdValue ? null : current.selectedThreadId,
          folders: adjustUnread(current.folders, sourceFolderId, message.read ? 0 : -1),
        };
      });
      get().addToast({
        message: permanently || inTrash ? '邮件已永久删除' : '邮件已移至垃圾箱',
        type: 'info',
      });
    };

    try {
      await mailApi.deleteMessage(thread.accountId, message.folderPath, message.uid);
      removeFromList(false);
    } catch (error) {
      const mailError = toMailApiError(error);
      if (mailError.code !== 'DELETE_NEEDS_CONFIRM') {
        get().addToast({ message: mailError.message, type: 'error' });
        return;
      }
      // No trash folder on the server: the delete would be permanent, so ask
      // first and send nothing if the user declines.
      if (!window.confirm(mailError.message)) return;
      try {
        await mailApi.deleteMessage(thread.accountId, message.folderPath, message.uid, true);
        removeFromList(true);
      } catch (retryError) {
        get().addToast({ message: toMailApiError(retryError).message, type: 'error' });
      }
    }
  },

  sendMessage: async (messageData) => {
    const state = get();
    const account = state.accounts.find(a => a.id === state.currentAccountId);
    if (!account) {
      get().addToast({ message: '请先添加账号后再发送邮件', type: 'warning' });
      return false;
    }

    const to = (messageData.to ?? []).map(c => c.email).join(', ');
    if (!to.trim()) {
      get().addToast({ message: '请输入收件人', type: 'error' });
      return false;
    }

    try {
      await mailApi.sendMessage(account.id, {
        to,
        cc: (messageData.cc ?? []).map(c => c.email).join(', '),
        bcc: (messageData.bcc ?? []).map(c => c.email).join(', '),
        subject: messageData.subject ?? '',
        html: messageData.body ?? '',
        text: messageData.bodyText ?? '',
        attachments: [],
      });

      set({ isComposing: false, composeDraft: null });
      get().addToast({ message: '邮件已发送', type: 'success' });

      const currentFolder = state.folders.find(f => f.id === state.currentFolderId);
      if (currentFolder?.type === 'sent') {
        await get().loadMessages(true);
      }
      return true;
    } catch (error) {
      const mailError = toMailApiError(error);
      get().addToast({ message: mailError.message, type: 'error' });
      return false;
    }
  },

  saveDraft: (draft) => {
    if (!get().accounts.some(a => a.id === draft.accountId)) {
      get().addToast({ message: '请先添加账号后再保存草稿', type: 'warning' });
      return;
    }
    set(current => ({
      drafts: [...current.drafts.filter(d => d.id !== draft.id), draft],
    }));
    persistFullState(get());
  },

  deleteDraft: (draftId) => {
    set(state => ({
      drafts: state.drafts.filter(d => d.id !== draftId),
    }));
    persistFullState(get());
  },

  setDensity: (density) => {
    set(state => ({ settings: { ...state.settings, density } }));
    persistFullState(get());
  },

  setFontSize: (fontSize) => {
    set(state => ({ settings: { ...state.settings, fontSize } }));
    persistFullState(get());
  },

  setLoading: (loading) => set({ isLoading: loading }),

  clearLocalData: async () => {
    const accounts = get().accounts;
    if (isTauriRuntime()) {
      await Promise.allSettled(
        accounts.map(account => mailApi.deleteAccount(account.id)),
      );
    }

    try {
      localStorage.removeItem(PERSIST_KEY_V3);
      for (const key of LEGACY_PERSIST_KEYS) {
        localStorage.removeItem(key);
      }
    } catch { /* ignore */ }

    loadSequence += 1;
    set({
      accounts: [],
      folders: [],
      threads: [],
      allMessages: [],
      drafts: [],
      currentAccountId: '',
      currentFolderId: '',
      selectedThreadId: null,
      sidebarCollapsed: false,
      searchQuery: '',
      searchFilter: 'all',
      isComposing: false,
      composeDraft: null,
      isSettingsOpen: false,
      isCommandPaletteOpen: false,
      isAccountFormOpen: false,
      toasts: [],
      isLoading: false,
      folderLoading: false,
      loadingMore: false,
      folderError: null,
      page: 0,
      hasMore: true,
      settings: { density: 'comfortable', fontSize: 14 },
    });
    get().addToast({ message: '本地数据已清空', type: 'success' });
  },

  // Computed helpers
  getFilteredThreads: () => {
    const state = get();
    if (!state.currentAccountId || !state.currentFolderId) return [];

    const currentFolder = state.folders.find(f => f.id === state.currentFolderId);
    if (!currentFolder) return [];

    let filtered: Thread[];
    if (currentFolder.type === 'starred') {
      filtered = state.threads.filter(t => t.isStarred);
    } else if (currentFolder.type === 'drafts') {
      filtered = [...currentDraftThreads(state), ...state.threads];
    } else {
      filtered = state.threads;
    }

    const query = state.searchQuery.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter(t =>
        (t.subject || '').toLowerCase().includes(query) ||
        t.participants.some(p =>
          (p.name || '').toLowerCase().includes(query) ||
          (p.email || '').toLowerCase().includes(query)
        ) ||
        t.messages.some(m =>
          (m.bodyText || '').toLowerCase().includes(query) ||
          (m.body || '').toLowerCase().includes(query)
        )
      );
    }

    if (state.searchFilter === 'unread') {
      filtered = filtered.filter(t => t.unreadCount > 0);
    } else if (state.searchFilter === 'attachments') {
      filtered = filtered.filter(t => t.hasAttachments);
    }

    return filtered;
  },

  getThreadById: (threadIdValue) => {
    const state = get();
    const fromServer = state.threads.find(t => t.id === threadIdValue);
    if (fromServer) return fromServer;
    return currentDraftThreads(state).find(t => t.id === threadIdValue);
  },

  getCurrentFolders: () => {
    const state = get();
    return state.folders.filter(f => f.accountId === state.currentAccountId);
  },

  getUnreadCount: (folderIdValue) => {
    const folder = get().folders.find(f => f.id === folderIdValue);
    const count = folder?.unreadCount ?? 0;
    return Number.isFinite(count) ? count : 0;
  },
}));
