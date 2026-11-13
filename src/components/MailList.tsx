import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Search, Star, Paperclip, Archive, Trash2, Mail, UserPlus,
  AlertCircle, RefreshCw, X,
} from 'lucide-react';
import { useMailStore } from '@/store/mailStore';
import { getInitials, formatMessageTime, formatDateGroup, truncate, stripHtml } from '@/lib/utils';
import { Thread } from '@/types';

export function MailList() {
  const store = useMailStore();
  const threads = store.getFilteredThreads();
  const density = store.settings.density;
  const rowHeight = density === 'comfortable' ? 56 : 44;
  const hasAccounts = store.accounts.length > 0;
  const currentFolder = store.folders.find(f => f.id === store.currentFolderId);

  // Group threads by date
  const groupedThreads = useMemo(() => {
    const groups: Record<string, Thread[]> = {};
    for (const thread of threads) {
      const group = formatDateGroup(thread.lastMessage.timestamp);
      if (!groups[group]) groups[group] = [];
      groups[group].push(thread);
    }
    return groups;
  }, [threads]);

  const groupOrder = ['今天', '昨天', '本周', '更早'];

  const handleListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    if (nearBottom) {
      void store.loadMoreMessages();
    }
  };

  const showFullLoading = store.folderLoading && threads.length === 0;
  const showFullError = !!store.folderError && threads.length === 0 && !store.folderLoading;

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-[var(--color-border-default)] bg-white">
      {/* Search & filter bar */}
      <div className="border-b border-[var(--color-border-default)] px-3 py-3">
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]"
          />
          <input
            data-search-input
            type="text"
            placeholder={hasAccounts ? '搜索邮件…' : '添加账号后可搜索邮件'}
            value={store.searchQuery}
            disabled={!hasAccounts}
            onChange={e => store.setSearchQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                store.setSearchQuery('');
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="h-9 w-full rounded-[10px] bg-[var(--color-fill)] pl-9 pr-8 text-[14px] outline-none transition-colors placeholder:text-[var(--color-text-tertiary)] focus:bg-[var(--color-fill-hover)] disabled:cursor-not-allowed disabled:opacity-55"
          />
          {store.searchQuery && (
            <button
              onClick={() => store.setSearchQuery('')}
              className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-[8px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[rgba(0,0,0,0.04)] hover:text-[var(--color-text-primary)]"
              title="清除搜索"
              aria-label="清除搜索"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {store.searchQuery && (
          <div className="mt-1.5 text-[12px] text-[var(--color-text-tertiary)]">
            {threads.length} 个结果 · 仅搜索当前文件夹已加载的 {store.threads.length} 封邮件
          </div>
        )}
        <div className={`flex items-center gap-1.5 ${store.searchQuery ? 'mt-1.5' : 'mt-2'}`}>
          <FilterButton label="全部" value="all" current={store.searchFilter} disabled={!hasAccounts} onClick={() => store.setSearchFilter('all')} />
          <FilterButton label="未读" value="unread" current={store.searchFilter} disabled={!hasAccounts} onClick={() => store.setSearchFilter('unread')} />
          <FilterButton label="有附件" value="attachments" current={store.searchFilter} disabled={!hasAccounts} onClick={() => store.setSearchFilter('attachments')} />
        </div>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto" onScroll={handleListScroll}>
        {!hasAccounts ? (
          <NoAccountState />
        ) : showFullLoading ? (
          <ListSkeleton rowHeight={rowHeight} />
        ) : showFullError ? (
          <ErrorState
            message={store.folderError ?? '加载失败'}
            detail={store.folderErrorDetail}
            onRetry={() => store.retryCurrentView()}
          />
        ) : threads.length === 0 ? (
          <EmptyState query={store.searchQuery} folderName={currentFolder?.name} />
        ) : (
          <>
            {groupOrder.map(groupName => {
              const groupThreads = groupedThreads[groupName];
              if (!groupThreads || groupThreads.length === 0) return null;
              return (
                <div key={groupName}>
                  <div className="sticky top-0 z-10 bg-white/95 px-3 pt-3 pb-1 text-[12px] text-[var(--color-text-tertiary)]">
                    {groupName}
                  </div>
                  {groupThreads.map(thread => (
                    <ThreadItem
                      key={thread.id}
                      thread={thread}
                      isSelected={store.selectedThreadId === thread.id}
                      rowHeight={rowHeight}
                      onClick={() => store.selectThread(thread.id)}
                    />
                  ))}
                </div>
              );
            })}
            {store.loadingMore && (
              <div className="flex flex-col items-center gap-2 py-4 text-[12px] text-[var(--color-text-tertiary)]">
                <span className="sk-pulse h-2.5 w-32 rounded-full" />
                正在加载更多邮件
              </div>
            )}
            {!store.loadingMore && store.folderError && (
              <div className="flex flex-col items-center justify-center gap-1 py-3 text-[12px]">
                <div className="flex items-center gap-2">
                  <span className="text-[var(--color-danger)]">{store.folderError}</span>
                  <button
                    onClick={() => store.retryCurrentView()}
                    className="btn btn-link h-7 px-1.5 text-[12px]"
                  >
                    重试
                  </button>
                </div>
                {store.folderErrorDetail && (
                  <p className="max-h-24 w-full overflow-y-auto whitespace-pre-wrap break-all px-3 font-mono text-[11px] leading-4 text-[var(--color-danger)] opacity-70 select-all">
                    {store.folderErrorDetail}
                  </p>
                )}
              </div>
            )}
            {!store.hasMore && threads.length > 0 && (
              <div className="py-3 text-center text-[12px] text-[var(--color-text-tertiary)]">
                已加载全部 {threads.length} 封邮件
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FilterButton({ label, value, current, disabled, onClick }: {
  label: string; value: string; current: string; disabled?: boolean; onClick: () => void;
}) {
  const isActive = value === current;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`h-8 rounded-full px-3 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
        isActive
          ? 'bg-[var(--color-accent)] text-white'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      {label}
    </button>
  );
}

function ThreadItem({ thread, isSelected, rowHeight, onClick }: {
  thread: Thread; isSelected: boolean; rowHeight: number; onClick: () => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const store = useMailStore();
  const lastMsg = thread.lastMessage;
  const senderName = lastMsg.from.name || lastMsg.from.email;
  const preview = truncate(lastMsg.bodyText || stripHtml(lastMsg.body), 60);

  const compact = rowHeight === 44;
  const paddingY = compact ? 6 : 8;
  const avatarSize = compact ? 'h-7 w-7 text-[10px]' : 'h-8 w-8 text-[11px]';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`relative flex cursor-pointer items-start gap-2.5 px-3 transition-colors ${
        isSelected ? 'bg-[var(--color-bg-selected)]' : 'hover:bg-[var(--color-bg-hover)]'
      }`}
      style={{ height: rowHeight, paddingTop: paddingY, paddingBottom: paddingY, overflow: 'hidden' }}
    >
      {/* Neutral avatar: no per-sender color, hierarchy comes from weight */}
      <div
        className={`${avatarSize} mt-0.5 flex flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-fill)] font-medium text-[var(--color-text-secondary)]`}
      >
        {getInitials(senderName)}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span
            className={`truncate ${
              compact ? 'text-[12px]' : 'text-[13px]'
            } ${
              thread.unreadCount > 0
                ? 'font-semibold text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-secondary)]'
            }`}
            style={{ fontSize: compact ? undefined : 'var(--font-size-body)' }}
          >
            {senderName}
          </span>
          <span className="flex-shrink-0 text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
            {formatMessageTime(lastMsg.timestamp)}
          </span>
        </div>
        <div
          className={`truncate ${
            compact ? 'text-[12px]' : 'text-[13px]'
          } ${
            thread.unreadCount > 0
              ? 'font-semibold text-[var(--color-text-primary)]'
              : 'text-[var(--color-text-secondary)]'
          }`}
          style={{ fontSize: compact ? undefined : 'var(--font-size-body)' }}
        >
          {thread.subject}
        </div>
        {!compact && (
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-tertiary)]">
              {preview}
            </span>
            <div className="flex flex-shrink-0 items-center gap-1">
              {thread.hasAttachments && (
                <Paperclip size={12} className="text-[var(--color-text-tertiary)]" />
              )}
              {thread.isStarred && (
                <Star
                  size={12}
                  className="fill-[var(--color-text-primary)] text-[var(--color-text-primary)]"
                />
              )}
            </div>
          </div>
        )}
        {compact && (thread.hasAttachments || thread.isStarred) && (
          <div className="mt-0.5 flex items-center gap-1">
            {thread.hasAttachments && (
              <Paperclip size={11} className="text-[var(--color-text-tertiary)]" />
            )}
            {thread.isStarred && (
              <Star
                size={11}
                className="fill-[var(--color-text-primary)] text-[var(--color-text-primary)]"
              />
            )}
          </div>
        )}
      </div>

      {/* Hover actions — 浮层，允许极淡投影，但列表行本身不动 */}
      <AnimatePresence>
        {isHovered && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-[10px] border border-[rgba(0,0,0,0.06)] bg-white p-0.5 shadow-[var(--shadow-pop)]"
          >
            <IconButton
              icon={<Archive size={14} />}
              title="归档 (e)"
              onClick={e => { e.stopPropagation(); void store.archiveThread(thread.id); }}
            />
            <IconButton
              icon={<Trash2 size={14} />}
              title="删除"
              onClick={e => { e.stopPropagation(); void store.deleteThread(thread.id); }}
            />
            <IconButton
              icon={
                <Star
                  size={14}
                  className={
                    thread.isStarred
                      ? 'fill-[var(--color-text-primary)] text-[var(--color-text-primary)]'
                      : ''
                  }
                />
              }
              title={thread.isStarred ? '取消星标 (s)' : '星标 (s)'}
              ariaPressed={thread.isStarred}
              onClick={e => { e.stopPropagation(); void store.toggleStarThread(thread.id); }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function IconButton({ icon, title, onClick, ariaPressed }: {
  icon: React.ReactNode; title: string;
  onClick: (e: React.MouseEvent) => void;
  ariaPressed?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={ariaPressed}
      aria-label={title}
      className="flex h-7 w-7 items-center justify-center rounded-[8px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-icon-hover)] hover:text-[var(--color-text-primary)]"
    >
      {icon}
    </button>
  );
}

function ListSkeleton({ rowHeight }: { rowHeight: number }) {
  return (
    <div>
      {Array.from({ length: 8 }).map((_, index) => (
        <div
          key={index}
          className="flex items-start gap-2.5 px-3"
          style={{ height: rowHeight, paddingTop: 8, paddingBottom: 8 }}
        >
          <div
            className={`sk-pulse flex-shrink-0 rounded-full ${
              rowHeight === 44 ? 'h-7 w-7' : 'h-8 w-8'
            }`}
          />
          <div className="min-w-0 flex-1 space-y-2 pt-0.5">
            <div className="sk-pulse h-2.5 w-1/3 rounded-full" />
            <div className="sk-pulse h-2.5 w-2/3 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function NoAccountState() {
  const store = useMailStore();

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
      <Mail size={20} className="mb-3 text-[var(--color-text-tertiary)]" strokeWidth={1.7} />
      <p className="text-[13px] text-[var(--color-text-tertiary)]">还没有账号</p>
      <p className="mt-1 text-[12px] text-[var(--color-text-tertiary)]">添加账号后开始收发邮件</p>
      <button
        onClick={() => store.openAccountForm()}
        className="btn btn-primary mt-4 h-9 px-4 text-[13px]"
      >
        <UserPlus size={14} />
        添加账号
      </button>
    </div>
  );
}

function ErrorState({ message, detail, onRetry }: {
  message: string; detail?: string | null; onRetry: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-[320px] rounded-[12px] bg-[var(--color-danger-soft)] px-4 py-4">
        <div className="flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0 text-[var(--color-danger)]" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-[var(--color-danger)]">无法加载邮件</p>
            <p className="mt-1 break-words text-[12px] leading-5 text-[var(--color-danger)]">
              {message}
            </p>
            {detail && (
              <p className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-[var(--color-danger)] opacity-70 select-all">
                {detail}
              </p>
            )}
          </div>
        </div>
        <button
          onClick={onRetry}
          className="btn btn-secondary mt-3 h-8 px-3 text-[13px]"
        >
          <RefreshCw size={13} />
          重试
        </button>
      </div>
    </div>
  );
}

function EmptyState({ query, folderName }: { query: string; folderName?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
      {query ? (
        <>
          <p className="text-[13px] text-[var(--color-text-tertiary)]">未找到匹配的邮件</p>
          <p className="mt-1 text-[12px] text-[var(--color-text-tertiary)]">
            仅搜索已加载的邮件，尝试滚动加载更多或更换关键词
          </p>
        </>
      ) : (
        <>
          <p className="text-[13px] text-[var(--color-text-tertiary)]">
            {folderName ? `${folderName}是空的` : '这里还没有邮件'}
          </p>
          <p className="mt-1 text-[12px] text-[var(--color-text-tertiary)]">收到的新邮件会显示在这里</p>
        </>
      )}
    </div>
  );
}
