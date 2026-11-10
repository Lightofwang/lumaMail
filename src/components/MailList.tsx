import { useState, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Search, Star, Paperclip, Archive, Trash2, Mail, UserPlus,
  Loader2, AlertCircle, RefreshCw, X,
} from 'lucide-react';
import { useMailStore } from '@/store/mailStore';
import { getInitials, getAvatarGradient, formatMessageTime, formatDateGroup, truncate, stripHtml } from '@/lib/utils';
import { Thread } from '@/types';

export function MailList() {
  const store = useMailStore();
  const threads = store.getFilteredThreads();
  const density = store.settings.density;
  const rowHeight = density === 'comfortable' ? 56 : 44;
  const hasAccounts = store.accounts.length > 0;
  const currentFolder = store.folders.find(f => f.id === store.currentFolderId);
  const listRef = useRef<HTMLDivElement>(null);

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
    <div className="flex flex-col h-full border-r border-[var(--color-border-default)] bg-white">
      {/* Search & filter bar */}
      <div className="px-4 py-3 border-b border-[var(--color-border-default)]">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
          <input
            data-search-input
            type="text"
            placeholder={hasAccounts ? '搜索当前文件夹已加载的邮件...' : '添加账号后可搜索邮件'}
            value={store.searchQuery}
            disabled={!hasAccounts}
            onChange={e => store.setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); store.setSearchQuery(''); (e.target as HTMLInputElement).blur(); } }}
            className="w-full pl-9 pr-8 py-2 rounded-[var(--radius-button)] border border-[var(--color-border-default)] bg-[var(--color-bg-sidebar)] text-sm placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-bg-accent-10)] transition-smooth disabled:cursor-not-allowed disabled:opacity-60"
          />
          {store.searchQuery && (
            <button
              onClick={() => store.setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-smooth"
              title="清除搜索"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {store.searchQuery && (
          <div className="text-xs text-[var(--color-text-tertiary)] mt-1.5">
            {threads.length} 个结果 · 仅搜索当前文件夹已加载的 {store.threads.length} 封邮件
          </div>
        )}
        <div className={`flex items-center gap-2 ${store.searchQuery ? 'mt-1' : 'mt-2'}`}>
          <FilterButton label="全部" value="all" current={store.searchFilter} disabled={!hasAccounts} onClick={() => store.setSearchFilter('all')} />
          <FilterButton label="未读" value="unread" current={store.searchFilter} disabled={!hasAccounts} onClick={() => store.setSearchFilter('unread')} />
          <FilterButton label="有附件" value="attachments" current={store.searchFilter} disabled={!hasAccounts} onClick={() => store.setSearchFilter('attachments')} />
        </div>
      </div>

      {/* Thread list */}
      <div ref={listRef} className="flex-1 overflow-y-auto" onScroll={handleListScroll}>
        {!hasAccounts ? (
          <NoAccountState />
        ) : showFullLoading ? (
          <ListSkeleton rowHeight={rowHeight} />
        ) : showFullError ? (
          <ErrorState message={store.folderError ?? '加载失败'} onRetry={() => void store.refreshFolders()} />
        ) : threads.length === 0 ? (
          <EmptyState query={store.searchQuery} folderName={currentFolder?.name} />
        ) : (
          <>
            {groupOrder.map(groupName => {
              const groupThreads = groupedThreads[groupName];
              if (!groupThreads || groupThreads.length === 0) return null;
              return (
                <div key={groupName}>
                  <div className="px-4 py-2 text-xs font-medium text-[var(--color-text-tertiary)] bg-[var(--color-bg-sidebar)] sticky top-0 z-10">
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
              <div className="flex items-center justify-center gap-2 py-3 text-xs text-[var(--color-text-tertiary)]">
                <Loader2 size={13} className="animate-spin" />
                正在加载更多邮件
              </div>
            )}
            {!store.loadingMore && store.folderError && (
              <div className="flex items-center justify-center gap-2 py-3 text-xs text-[var(--color-text-tertiary)]">
                <span className="text-[var(--color-error)]">{store.folderError}</span>
                <button onClick={() => void store.loadMoreMessages()} className="text-[var(--color-accent)] hover:underline">
                  重试
                </button>
              </div>
            )}
            {!store.hasMore && threads.length > 0 && (
              <div className="py-3 text-center text-[11px] text-[var(--color-text-tertiary)]">
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
      className={`px-2.5 py-1 rounded-[var(--radius-tag)] text-xs font-medium transition-smooth disabled:cursor-not-allowed disabled:opacity-50 ${
        isActive
          ? 'bg-[var(--color-accent)] text-white'
          : 'bg-[var(--color-bg-sidebar)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
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
  const avatarGradient = getAvatarGradient(lastMsg.from.email);

  // Adjust padding based on density
  const paddingY = rowHeight === 44 ? 6 : 8;

  return (
    <motion.div
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`relative flex items-start gap-3 px-4 cursor-pointer transition-smooth ${
        isSelected
          ? 'bg-[var(--color-bg-selected)] border-l-3 border-l-[var(--color-accent)]'
          : thread.unreadCount > 0
          ? 'bg-[var(--color-bg-unread)] hover:bg-[var(--color-bg-hover)] border-l-3 border-l-transparent'
          : 'hover:bg-[var(--color-bg-hover)] border-l-3 border-l-transparent'
      }`}
      style={{ height: rowHeight, paddingTop: paddingY, paddingBottom: paddingY, overflow: 'hidden' }}
    >
      {/* Unread dot */}
      {thread.unreadCount > 0 && !isSelected && (
        <div className="absolute left-1 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
      )}

      {/* Avatar */}
      <div
        className={`rounded-full flex items-center justify-center text-white font-bold flex-shrink-0 mt-0.5 ${rowHeight === 44 ? 'w-7 h-7 text-[10px]' : 'w-9 h-9 text-xs'}`}
        style={{ backgroundImage: `linear-gradient(135deg, ${avatarGradient[0]}, ${avatarGradient[1]})` }}
      >
        {getInitials(senderName)}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className={`truncate ${rowHeight === 44 ? 'text-xs' : 'text-sm'} ${thread.unreadCount > 0 ? 'font-semibold text-[var(--color-text-primary)]' : 'font-medium text-[var(--color-text-secondary)]'}`} style={{ fontSize: rowHeight > 44 ? 'var(--font-size-body)' : undefined }}>
            {senderName}
          </span>
          <span className="text-xs text-[var(--color-text-tertiary)] flex-shrink-0">
            {formatMessageTime(lastMsg.timestamp)}
          </span>
        </div>
        <div className={`truncate ${rowHeight === 44 ? 'text-xs' : 'text-sm'} ${thread.unreadCount > 0 ? 'font-semibold text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}`} style={{ fontSize: rowHeight > 44 ? 'var(--font-size-body)' : undefined }}>
          {thread.subject}
        </div>
        {rowHeight > 44 && (
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-xs text-[var(--color-text-tertiary)] truncate flex-1">{preview}</span>
            <div className="flex items-center gap-1 flex-shrink-0">
              {thread.hasAttachments && <Paperclip size={12} className="text-[var(--color-text-tertiary)]" />}
              {thread.isStarred && <Star size={12} className="text-[var(--color-warning)] fill-[var(--color-warning)]" />}
            </div>
          </div>
        )}
        {rowHeight === 44 && (thread.hasAttachments || thread.isStarred) && (
          <div className="flex items-center gap-1 mt-0.5">
            {thread.hasAttachments && <Paperclip size={11} className="text-[var(--color-text-tertiary)]" />}
            {thread.isStarred && <Star size={11} className="text-[var(--color-warning)] fill-[var(--color-warning)]" />}
          </div>
        )}
      </div>

      {/* Hover actions */}
      <AnimatePresence>
        {isHovered && (
          <motion.div
            initial={{ opacity: 0, x: 4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 4 }}
            className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 bg-white rounded-[var(--radius-sm)] shadow-[var(--shadow-card)] border border-[var(--color-border-default)] p-0.5"
          >
            <IconButton icon={<Archive size={14} />} title="归档 (e)" onClick={(e) => { e.stopPropagation(); void store.archiveThread(thread.id); }} />
            <IconButton icon={<Trash2 size={14} />} title="删除" onClick={(e) => { e.stopPropagation(); void store.deleteThread(thread.id); }} />
            <IconButton
              icon={<Star size={14} className={thread.isStarred ? 'fill-[var(--color-warning)] text-[var(--color-warning)]' : ''} />}
              title={thread.isStarred ? '取消星标 (s)' : '星标 (s)'}
              aria-pressed={thread.isStarred}
              onClick={(e) => { e.stopPropagation(); void store.toggleStarThread(thread.id); }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function IconButton({ icon, title, onClick, ariaPressed }: { icon: React.ReactNode; title: string; onClick: (e: React.MouseEvent) => void; ariaPressed?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={ariaPressed}
      aria-label={title}
      className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] transition-smooth"
    >
      {icon}
    </button>
  );
}

function ListSkeleton({ rowHeight }: { rowHeight: number }) {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 8 }).map((_, index) => (
        <div
          key={index}
          className="flex items-start gap-3 px-4 border-l-3 border-l-transparent"
          style={{ height: rowHeight, paddingTop: 8, paddingBottom: 8 }}
        >
          <div className={`rounded-full bg-[var(--color-bg-hover)] flex-shrink-0 ${rowHeight === 44 ? 'w-7 h-7' : 'w-9 h-9'}`} />
          <div className="flex-1 min-w-0 space-y-2 pt-0.5">
            <div className="h-3 rounded bg-[var(--color-bg-hover)] w-1/3" />
            <div className="h-3 rounded bg-[var(--color-bg-sidebar)] w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function NoAccountState() {
  const store = useMailStore();

  return (
    <div className="flex flex-col items-center justify-center h-full py-16 px-4 text-center">
      <div className="w-16 h-16 rounded-full bg-[var(--color-bg-sidebar)] flex items-center justify-center mb-4">
        <Mail size={24} className="text-[var(--color-text-tertiary)]" />
      </div>
      <p className="text-sm font-medium text-[var(--color-text-secondary)]">还没有账号</p>
      <p className="text-xs text-[var(--color-text-tertiary)] mt-1">添加账号后开始收发邮件</p>
      <button
        onClick={() => store.openAccountForm()}
        className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius-button)] bg-[var(--color-accent)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] transition-smooth focus-ring"
      >
        <UserPlus size={15} />
        添加账号
      </button>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-16 px-6 text-center">
      <div className="w-16 h-16 rounded-full bg-[var(--color-error)]/10 flex items-center justify-center mb-4">
        <AlertCircle size={24} className="text-[var(--color-error)]" />
      </div>
      <p className="text-sm font-medium text-[var(--color-text-secondary)]">无法加载邮件</p>
      <p className="text-xs text-[var(--color-text-tertiary)] mt-1 break-words">{message}</p>
      <button
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius-button)] border border-[var(--color-border-default)] text-[var(--color-text-secondary)] text-sm font-medium hover:bg-[var(--color-bg-hover)] transition-smooth"
      >
        <RefreshCw size={14} />
        重试
      </button>
    </div>
  );
}

function EmptyState({ query, folderName }: { query: string; folderName?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-16 px-4 text-center">
      <div className="w-16 h-16 rounded-full bg-[var(--color-bg-sidebar)] flex items-center justify-center mb-4">
        <Search size={24} className="text-[var(--color-text-tertiary)]" />
      </div>
      {query ? (
        <>
          <p className="text-sm font-medium text-[var(--color-text-secondary)]">未找到匹配的邮件</p>
          <p className="text-xs text-[var(--color-text-tertiary)] mt-1">仅搜索已加载的邮件，尝试滚动加载更多或更换关键词</p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-[var(--color-text-secondary)]">
            {folderName ? `${folderName}是空的` : '这里还没有邮件'}
          </p>
          <p className="text-xs text-[var(--color-text-tertiary)] mt-1">这里还没有邮件</p>
        </>
      )}
    </div>
  );
}
