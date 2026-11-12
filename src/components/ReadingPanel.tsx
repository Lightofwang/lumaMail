import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Reply, Forward, Archive, Trash2, Star,
  Paperclip, ChevronDown, ChevronUp, Download, UserPlus, AlertCircle, RefreshCw,
  Image as ImageIcon, Mail,
} from 'lucide-react';
import { useMailStore } from '@/store/mailStore';
import { getInitials, formatFullDate, formatFileSize } from '@/lib/utils';
import { sanitizeMailHtml } from '@/lib/sanitizeHtml';
import { Message, Attachment, Thread } from '@/types';

export function ReadingPanel() {
  const store = useMailStore();
  const thread = store.selectedThreadId ? store.getThreadById(store.selectedThreadId) : null;

  if (store.accounts.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center bg-white p-6">
        <div className="max-w-sm text-center">
          <Mail size={20} className="mx-auto mb-3 text-[var(--color-text-tertiary)]" strokeWidth={1.7} />
          <p className="text-[13px] text-[var(--color-text-tertiary)]">还没有账号</p>
          <p className="mt-1 text-[12px] text-[var(--color-text-tertiary)]">添加账号后开始收发邮件</p>
          <button
            onClick={() => store.openAccountForm()}
            className="btn btn-secondary mt-4 h-9 px-4 text-[13px]"
          >
            <UserPlus size={14} />
            添加账号
          </button>
        </div>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex flex-1 items-center justify-center bg-white p-6">
        <div className="text-center">
          <Mail size={20} className="mx-auto mb-3 text-[var(--color-text-tertiary)]" strokeWidth={1.7} />
          <p className="text-[13px] text-[var(--color-text-tertiary)]">选择一封邮件开始阅读</p>
        </div>
      </div>
    );
  }

  const lastMessage = thread.lastMessage;

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-white">
      {/* Header */}
      <div className="border-b border-[var(--color-border-default)] px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1
              className="truncate text-[20px] leading-7 font-semibold text-[var(--color-text-primary)]"
              title={thread.subject}
            >
              {thread.subject}
            </h1>
            <div className="mt-1 flex items-center gap-2 text-[12px] text-[var(--color-text-tertiary)]">
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
          <div className="flex flex-shrink-0 items-center gap-0.5">
            <ActionButton
              icon={<Reply size={16} />}
              label="回复"
              onClick={() => {
                store.openCompose({
                  to: [lastMessage.from],
                  subject: thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`,
                });
              }}
            />
            <ActionButton
              icon={<Forward size={16} />}
              label="转发"
              onClick={() => {
                const forwarded = lastMessage.body || (lastMessage.bodyText
                  ? `<p>${escapeHtml(lastMessage.bodyText)}</p>`
                  : '');
                store.openCompose({
                  subject: `Fwd: ${thread.subject}`,
                  body: `<br/><br/>---------- 转发邮件 ----------<br/>${forwarded}`,
                });
              }}
            />
            <ActionButton icon={<Archive size={16} />} label="归档" onClick={() => void store.archiveThread(thread.id)} />
            <ActionButton icon={<Trash2 size={16} />} label="删除" onClick={() => void store.deleteThread(thread.id)} />
            <ActionButton
              icon={
                <Star
                  size={16}
                  className={
                    thread.isStarred
                      ? 'fill-[var(--color-text-primary)] text-[var(--color-text-primary)]'
                      : ''
                  }
                />
              }
              label={thread.isStarred ? '取消星标' : '星标'}
              ariaPressed={thread.isStarred}
              onClick={() => void store.toggleStarThread(thread.id)}
            />
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[780px] px-6 py-6">
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
      <div className="border-t border-[var(--color-border-default)] px-6 py-4">
        <div className="mx-auto max-w-[780px]">
          <button
            onClick={() => store.openCompose({
              to: [lastMessage.from],
              subject: thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`,
            })}
            className="h-11 w-full rounded-[10px] bg-[var(--color-fill)] px-4 text-left text-[14px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-fill-hover)]"
          >
            点击回复…
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
        className="flex items-center gap-1.5 rounded-[8px] px-1 py-1 text-[13px] text-[var(--color-link)] transition-colors hover:bg-[rgba(23,131,255,0.08)]"
      >
        {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        <span>{expanded ? '收起' : '展开'} {hiddenMessages.length} 封早期邮件</span>
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0.8, 0.25, 1] }}
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
  const [showImages, setShowImages] = useState(false);

  const sanitized = useMemo(
    () => sanitizeMailHtml(message.body, { allowRemoteImages: showImages }),
    [message.body, showImages],
  );

  const avatarSize = compact ? 'h-8 w-8 text-[11px]' : 'h-9 w-9 text-[12px]';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      className={`${isLast ? '' : 'border-b border-[var(--color-border-default)]'} ${
        compact ? 'mb-3 pb-3' : 'mb-6 pb-6'
      }`}
    >
      {/* Sender info */}
      <div className="flex items-start gap-3">
        <div
          className={`${avatarSize} flex flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-fill)] font-medium text-[var(--color-text-secondary)]`}
        >
          {getInitials(message.from.name || message.from.email)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[14px] font-medium text-[var(--color-text-primary)]">
              {message.from.name || message.from.email}
            </span>
            <span className="flex-shrink-0 text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
              {formatFullDate(message.timestamp)}
            </span>
          </div>
          {!compact && (
            <div className="mt-0.5 text-[12px] text-[var(--color-text-tertiary)]">
              收件人：{message.to.map(t => t.name || t.email).join(', ')}
              {message.cc.length > 0 && `；抄送：${message.cc.map(c => c.name || c.email).join(', ')}`}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      {message.detailLoading ? (
        <div className="mt-4 space-y-2">
          <div className="sk-pulse h-3 w-full rounded-full" />
          <div className="sk-pulse h-3 w-11/12 rounded-full" />
          <div className="sk-pulse h-3 w-2/3 rounded-full" />
          <p className="pt-1 text-[12px] text-[var(--color-text-tertiary)]">正在加载正文…</p>
        </div>
      ) : message.detailError ? (
        <div className="notice notice-error mt-4 flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px]">{message.detailError}</p>
            <button
              onClick={() => store.retryThreadDetail(thread.id)}
              className="btn btn-link mt-1 h-7 px-2 text-[12px]"
            >
              <RefreshCw size={12} />
              重试加载正文
            </button>
          </div>
        </div>
      ) : (
        <>
          {sanitized.blockedImages > 0 && !showImages && !compact && (
            <div className="notice notice-neutral mt-3 flex items-center gap-2">
              <ImageIcon size={14} className="flex-shrink-0" />
              <span className="min-w-0 flex-1 text-[12px]">
                为保护隐私，已阻止加载 {sanitized.blockedImages} 张远程图片
              </span>
              <button
                onClick={() => setShowImages(true)}
                className="btn btn-link h-7 flex-shrink-0 px-2 text-[12px]"
              >
                显示图片
              </button>
            </div>
          )}
          {sanitized.html ? (
            <div
              className={`mail-body mt-4 ${compact ? 'line-clamp-3 text-[13px]' : ''}`}
              style={{ fontSize: compact ? undefined : 'var(--font-size-body)' }}
              dangerouslySetInnerHTML={{ __html: sanitized.html }}
            />
          ) : message.detailLoading ? null : (
            <div
              className={`mail-body mt-4 whitespace-pre-wrap break-words ${
                compact ? 'line-clamp-3 text-[13px]' : ''
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
        <div className="mt-4 border-t border-[var(--color-border-default)] pt-3">
          <div className="mb-2 text-[12px] text-[var(--color-text-tertiary)]">
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
      className="flex items-center gap-2 rounded-[10px] bg-[var(--color-surface)] px-3 py-2 text-left transition-colors hover:bg-[var(--color-fill-hover)]"
    >
      <Paperclip size={14} className="flex-shrink-0 text-[var(--color-text-tertiary)]" />
      <div className="min-w-0">
        <div className="max-w-[220px] truncate text-[13px] text-[var(--color-text-primary)]">
          {attachment.filename}
        </div>
        <div className="text-[12px] text-[var(--color-text-tertiary)]">{formatFileSize(attachment.size)}</div>
      </div>
      <Download size={13} className="ml-1 flex-shrink-0 text-[var(--color-text-tertiary)]" />
    </button>
  );
}

function ActionButton({ icon, label, onClick, ariaPressed }: {
  icon: React.ReactNode; label: string; onClick: () => void; ariaPressed?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-pressed={ariaPressed}
      aria-label={label}
      className="icon-btn"
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
