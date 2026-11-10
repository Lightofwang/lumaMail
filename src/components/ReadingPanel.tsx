import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Reply, Forward, Archive, Trash2, Star,
  Paperclip, ChevronDown, ChevronUp, Download, UserPlus, AlertCircle, RefreshCw, Image as ImageIcon,
} from 'lucide-react';
import { useMailStore } from '@/store/mailStore';
import { getInitials, getAvatarGradient, formatFullDate, formatFileSize } from '@/lib/utils';
import { sanitizeMailHtml } from '@/lib/sanitizeHtml';
import { Message, Attachment, Thread } from '@/types';

export function ReadingPanel() {
  const store = useMailStore();
  const thread = store.selectedThreadId ? store.getThreadById(store.selectedThreadId) : null;

  if (store.accounts.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white">
        <div className="text-center max-w-sm px-6">
          <div className="w-20 h-20 rounded-full bg-[var(--color-bg-sidebar)] flex items-center justify-center mx-auto mb-4">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[var(--color-text-tertiary)]">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M22 7l-10 7L2 7" />
            </svg>
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
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white">
        <div className="text-center">
          <div className="w-20 h-20 rounded-full bg-[var(--color-bg-sidebar)] flex items-center justify-center mx-auto mb-4">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[var(--color-text-tertiary)]">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M22 7l-10 7L2 7" />
            </svg>
          </div>
          <p className="text-sm text-[var(--color-text-tertiary)]">选择一封邮件开始阅读</p>
        </div>
      </div>
    );
  }

  const lastMessage = thread.lastMessage;

  return (
    <div className="flex-1 flex flex-col bg-white overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-[var(--color-border-default)]">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-[var(--color-text-primary)] truncate">
              {thread.subject}
            </h1>
            <div className="flex items-center gap-2 mt-1 text-xs text-[var(--color-text-tertiary)]">
              <span>{thread.messages.length} 封邮件</span>
              {thread.hasAttachments && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <Paperclip size={12} />
                    附件
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <ActionButton icon={<Reply size={16} />} label="回复" onClick={() => {
              store.openCompose({
                to: [lastMessage.from],
                subject: thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`,
              });
            }} />
            <ActionButton icon={<Forward size={16} />} label="转发" onClick={() => {
              const forwarded = lastMessage.body || (lastMessage.bodyText
                ? `<p>${escapeHtml(lastMessage.bodyText)}</p>`
                : '');
              store.openCompose({
                subject: `Fwd: ${thread.subject}`,
                body: `<br/><br/>---------- 转发邮件 ----------<br/>${forwarded}`,
              });
            }} />
            <ActionButton icon={<Archive size={16} />} label="归档" onClick={() => void store.archiveThread(thread.id)} />
            <ActionButton icon={<Trash2 size={16} />} label="删除" onClick={() => void store.deleteThread(thread.id)} />
            <ActionButton
              icon={<Star size={16} className={thread.isStarred ? 'fill-[var(--color-warning)] text-[var(--color-warning)]' : ''} />}
              label={thread.isStarred ? '取消星标' : '星标'}
              ariaPressed={thread.isStarred}
              onClick={() => void store.toggleStarThread(thread.id)}
            />
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[680px] mx-auto px-6 py-4">
          {thread.messages.length > 2 && (
            <CollapsedMessages thread={thread} />
          )}
          {(thread.messages.length <= 2 ? thread.messages : thread.messages.slice(-2)).map((msg, idx, arr) => (
            <MessageCard
              key={msg.id}
              message={msg}
              isLast={idx === arr.length - 1}
              thread={thread}
            />
          ))}
        </div>
      </div>

      {/* Inline reply */}
      <div className="px-6 py-4 border-t border-[var(--color-border-default)]">
        <div className="max-w-[680px] mx-auto">
          <button
            onClick={() => store.openCompose({
              to: [lastMessage.from],
              subject: thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`,
            })}
            className="w-full rounded-[var(--radius-button)] border border-[var(--color-border-default)] px-4 py-3 text-sm text-[var(--color-text-tertiary)] text-left hover:border-[var(--color-accent)] hover:text-[var(--color-text-secondary)] transition-smooth focus-ring"
          >
            点击回复...
          </button>
        </div>
      </div>
    </div>
  );
}

function CollapsedMessages({ thread }: { thread: Thread }) {
  const [expanded, setExpanded] = useState(false);
  const hiddenMessages = thread.messages.slice(0, -2);

  return (
    <div className="mb-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm text-[var(--color-accent)] hover:underline"
      >
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        <span>{expanded ? '收起' : '展开'} {hiddenMessages.length} 封早期邮件</span>
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            {hiddenMessages.map(msg => (
              <MessageCard key={msg.id} message={msg} isLast={false} thread={thread} compact />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MessageCard({ message, isLast, thread, compact = false }: {
  message: Message; isLast: boolean; thread: Thread; compact?: boolean;
}) {
  const store = useMailStore();
  const avatarGradient = getAvatarGradient(message.from.email);
  const [showImages, setShowImages] = useState(false);

  const sanitized = useMemo(
    () => sanitizeMailHtml(message.body, { allowRemoteImages: showImages }),
    [message.body, showImages],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-[var(--radius-card)] border border-[var(--color-border-default)] ${
        isLast ? 'bg-white' : 'bg-[var(--color-bg-sidebar)]'
      } ${compact ? 'p-3 mb-2' : 'p-5 mb-4'}`}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      {/* Sender info */}
      <div className="flex items-start gap-3">
        <div
          className={`rounded-full bg-gradient-to-br flex items-center justify-center text-white font-bold flex-shrink-0 ${
            compact ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm'
          }`}
          style={{ backgroundImage: `linear-gradient(135deg, ${avatarGradient[0]}, ${avatarGradient[1]})` }}
        >
          {getInitials(message.from.name || message.from.email)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className={`font-medium text-[var(--color-text-primary)] truncate ${compact ? 'text-sm' : ''}`}>
              {message.from.name || message.from.email}
            </span>
            <span className="text-xs text-[var(--color-text-tertiary)] flex-shrink-0">
              {formatFullDate(message.timestamp)}
            </span>
          </div>
          {!compact && (
            <div className="text-xs text-[var(--color-text-tertiary)] mt-0.5">
              收件人：{message.to.map(t => t.name || t.email).join(', ')}
              {message.cc.length > 0 && `；抄送：${message.cc.map(c => c.name || c.email).join(', ')}`}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      {message.detailLoading ? (
        <div className="mt-4 space-y-2 animate-pulse">
          <div className="h-3 rounded bg-[var(--color-bg-sidebar)] w-full" />
          <div className="h-3 rounded bg-[var(--color-bg-sidebar)] w-11/12" />
          <div className="h-3 rounded bg-[var(--color-bg-sidebar)] w-2/3" />
          <p className="pt-1 text-xs text-[var(--color-text-tertiary)]">正在加载正文…</p>
        </div>
      ) : message.detailError ? (
        <div className="mt-4 flex items-start gap-2 px-3 py-2.5 rounded-[var(--radius-button)] bg-[var(--color-error)]/10 border border-[var(--color-error)]/20">
          <AlertCircle size={16} className="text-[var(--color-error)] flex-shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-[var(--color-error)]">{message.detailError}</p>
            <button
              onClick={() => store.retryThreadDetail(thread.id)}
              className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--color-accent)] hover:underline"
            >
              <RefreshCw size={11} />
              重试加载正文
            </button>
          </div>
        </div>
      ) : (
        <>
          {sanitized.blockedImages > 0 && !showImages && !compact && (
            <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-[var(--radius-button)] bg-[var(--color-bg-sidebar)] border border-[var(--color-border-default)]">
              <ImageIcon size={14} className="text-[var(--color-text-tertiary)]" />
              <span className="flex-1 text-xs text-[var(--color-text-tertiary)]">
                为保护隐私，已阻止加载 {sanitized.blockedImages} 张远程图片
              </span>
              <button
                onClick={() => setShowImages(true)}
                className="text-xs font-medium text-[var(--color-accent)] hover:underline"
              >
                显示图片
              </button>
            </div>
          )}
          {sanitized.html ? (
            <div
              className={`mt-3 text-[var(--color-text-primary)] leading-[1.7] prose prose-sm max-w-none ${
                compact ? 'text-sm line-clamp-3' : ''
              }`}
              style={{ fontSize: compact ? undefined : 'var(--font-size-body)' }}
              dangerouslySetInnerHTML={{ __html: sanitized.html }}
            />
          ) : message.detailLoading ? null : (
            <div
              className={`mt-3 whitespace-pre-wrap break-words text-[var(--color-text-primary)] leading-[1.7] ${
                compact ? 'text-sm line-clamp-3' : ''
              }`}
              style={{ fontSize: compact ? undefined : 'var(--font-size-body)' }}
            >
              {message.bodyText || (message.detailLoaded ? '（无正文内容）' : '')}
            </div>
          )}
        </>
      )}

      {/* Attachments */}
      {!compact && message.attachments.length > 0 && (
        <div className="mt-4 pt-3 border-t border-[var(--color-border-default)]">
          <div className="text-xs font-medium text-[var(--color-text-tertiary)] mb-2">
            {message.attachments.length} 个附件
          </div>
          <div className="flex flex-wrap gap-2">
            {message.attachments.map(att => (
              <AttachmentCard key={att.id} thread={thread} attachment={att} />
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}

function AttachmentCard({ thread, attachment }: { thread: Thread; attachment: Attachment }) {
  const store = useMailStore();

  return (
    <button
      onClick={() => void store.saveAttachment(thread, attachment)}
      title={`下载 ${attachment.filename}`}
      className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-button)] border border-[var(--color-border-default)] bg-[var(--color-bg-sidebar)] hover:bg-[var(--color-bg-hover)] transition-smooth text-left"
    >
      <Paperclip size={14} className="text-[var(--color-text-tertiary)] flex-shrink-0" />
      <div className="min-w-0">
        <div className="text-xs font-medium text-[var(--color-text-primary)] truncate">{attachment.filename}</div>
        <div className="text-xs text-[var(--color-text-tertiary)]">{formatFileSize(attachment.size)}</div>
      </div>
      <Download size={13} className="text-[var(--color-text-tertiary)] flex-shrink-0 ml-1" />
    </button>
  );
}

function ActionButton({ icon, label, onClick, ariaPressed }: { icon: React.ReactNode; label: string; onClick: () => void; ariaPressed?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-pressed={ariaPressed}
      aria-label={label}
      className="p-2 rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] transition-smooth focus-ring"
    >
      {icon}
    </button>
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
