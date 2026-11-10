import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Bold, Italic, Underline, List, Link, Quote, Send, Save, Paperclip, UserPlus, Loader2 } from 'lucide-react';
import { useMailStore } from '@/store/mailStore';
import { sanitizeComposeHtml } from '@/lib/sanitizeHtml';
import { Contact } from '@/types';

interface ComposeModalProps {
  initialData?: {
    to?: Contact[];
    cc?: Contact[];
    bcc?: Contact[];
    subject?: string;
    body?: string;
  } | null;
}

export function ComposeModal({ initialData }: ComposeModalProps) {
  const store = useMailStore();
  const [to, setTo] = useState(initialData?.to?.map(c => c.email).join(', ') || '');
  const [cc, setCc] = useState(initialData?.cc?.map(c => c.email).join(', ') || '');
  const [bcc, setBcc] = useState(initialData?.bcc?.map(c => c.email).join(', ') || '');
  const [subject, setSubject] = useState(initialData?.subject || '');
  const [showCc, setShowCc] = useState(!!(initialData?.cc && initialData.cc.length > 0));
  const [showBcc, setShowBcc] = useState(!!(initialData?.bcc && initialData.bcc.length > 0));
  const [body, setBody] = useState(initialData?.body || '');
  const [sending, setSending] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const hasAccounts = store.accounts.length > 0;
  const account = store.accounts.find(a => a.id === store.currentAccountId);

  useEffect(() => {
    if (editorRef.current && initialData?.body) {
      // Forwarded/replied content is untrusted HTML: sanitize before it enters
      // the editable DOM.
      const safe = sanitizeComposeHtml(initialData.body);
      editorRef.current.innerHTML = safe;
      setBody(safe);
    }
  }, []);

  const handleSend = async () => {
    if (sending) return;
    if (!hasAccounts) {
      store.addToast({ message: '请先添加账号后再发送邮件', type: 'warning' });
      return;
    }
    if (!to.trim()) {
      store.addToast({ message: '请输入收件人', type: 'error' });
      return;
    }

    const toContacts: Contact[] = to.split(/[,;]/).map(e => ({ name: e.trim(), email: e.trim() })).filter(c => c.email);
    const ccContacts: Contact[] = cc ? cc.split(/[,;]/).map(e => ({ name: e.trim(), email: e.trim() })).filter(c => c.email) : [];
    const bccContacts: Contact[] = bcc ? bcc.split(/[,;]/).map(e => ({ name: e.trim(), email: e.trim() })).filter(c => c.email) : [];

    const htmlBody = editorRef.current?.innerHTML || body || '';

    setSending(true);
    try {
      // On success the store closes the modal; on failure the toast explains why
      // and the draft stays open so the user does not lose their text.
      await store.sendMessage({
        to: toContacts,
        cc: ccContacts,
        bcc: bccContacts,
        subject: subject.trim() || '(无主题)',
        body: htmlBody,
        bodyText: htmlBody.replace(/<[^>]*>/g, ''),
      });
    } finally {
      setSending(false);
    }
  };

  const handleSaveDraft = () => {
    if (!hasAccounts) {
      store.addToast({ message: '请先添加账号后再保存草稿', type: 'warning' });
      return;
    }
    store.saveDraft({
      id: `draft-${Date.now()}`,
      accountId: store.currentAccountId,
      to, cc, bcc, subject,
      body: editorRef.current?.innerHTML || body || '',
      timestamp: new Date().toISOString(),
    });
    store.addToast({ message: '草稿已保存到本地', type: 'success' });
    store.closeCompose();
  };

  const execCommand = (command: string, value?: string) => {
    document.execCommand(command, false, value);
    editorRef.current?.focus();
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
        className="fixed bottom-4 right-4 w-[560px] max-h-[80vh] bg-white rounded-[var(--radius-card)] shadow-[var(--shadow-dropdown)] border border-[var(--color-border-default)] flex flex-col z-50 overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border-default)]">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">新邮件</h2>
            {account && (
              <p className="text-[11px] text-[var(--color-text-tertiary)] truncate">发件账号：{account.email}</p>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleSaveDraft}
              disabled={!hasAccounts || sending}
              className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-hover)] transition-smooth disabled:cursor-not-allowed disabled:opacity-40"
              title={hasAccounts ? '存草稿（仅本地）' : '请先添加账号'}
            >
              <Save size={16} />
            </button>
            <button
              onClick={() => store.closeCompose()}
              disabled={sending}
              className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-hover)] transition-smooth disabled:opacity-40"
              title="关闭 (Esc)"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {!hasAccounts && (
          <div className="flex items-start gap-2 px-4 py-2.5 border-b border-[var(--color-border-default)] bg-[var(--color-warning)]/10">
            <UserPlus size={15} className="text-[var(--color-warning)] flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-[var(--color-text-secondary)]">还没有账号，添加账号后才能发送邮件。</p>
              <button
                onClick={() => store.openAccountForm()}
                className="mt-0.5 text-xs font-medium text-[var(--color-accent)] hover:underline"
              >
                去添加账号
              </button>
            </div>
          </div>
        )}

        {/* Fields */}
        <div className="px-4 py-2 border-b border-[var(--color-border-default)]">
          <div className="flex items-center gap-2 py-1.5">
            <label className="text-xs text-[var(--color-text-tertiary)] w-8 flex-shrink-0">收件人</label>
            <input
              type="text"
              value={to}
              onChange={e => setTo(e.target.value)}
              disabled={sending}
              className="flex-1 text-sm outline-none placeholder:text-[var(--color-text-tertiary)] disabled:opacity-60"
              placeholder="输入邮箱地址，多个用逗号分隔"
            />
            <div className="flex items-center gap-2 flex-shrink-0">
              {!showCc && (
                <button onClick={() => setShowCc(true)} disabled={sending} className="text-xs text-[var(--color-accent)] hover:underline">抄送</button>
              )}
              {!showBcc && (
                <button onClick={() => setShowBcc(true)} disabled={sending} className="text-xs text-[var(--color-accent)] hover:underline">密送</button>
              )}
            </div>
          </div>
          {showCc && (
            <div className="flex items-center gap-2 py-1.5">
              <label className="text-xs text-[var(--color-text-tertiary)] w-8 flex-shrink-0">抄送</label>
              <input
                type="text"
                value={cc}
                onChange={e => setCc(e.target.value)}
                disabled={sending}
                className="flex-1 text-sm outline-none placeholder:text-[var(--color-text-tertiary)] disabled:opacity-60"
                placeholder="抄送"
              />
              <button onClick={() => { setShowCc(false); setCc(''); }} disabled={sending} className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">
                <X size={14} />
              </button>
            </div>
          )}
          {showBcc && (
            <div className="flex items-center gap-2 py-1.5">
              <label className="text-xs text-[var(--color-text-tertiary)] w-8 flex-shrink-0">密送</label>
              <input
                type="text"
                value={bcc}
                onChange={e => setBcc(e.target.value)}
                disabled={sending}
                className="flex-1 text-sm outline-none placeholder:text-[var(--color-text-tertiary)] disabled:opacity-60"
                placeholder="密送"
              />
              <button onClick={() => { setShowBcc(false); setBcc(''); }} disabled={sending} className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">
                <X size={14} />
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 py-1.5 border-t border-[var(--color-border-default)]">
            <label className="text-xs text-[var(--color-text-tertiary)] w-8 flex-shrink-0">主题</label>
            <input
              type="text"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              disabled={sending}
              className="flex-1 text-sm outline-none placeholder:text-[var(--color-text-tertiary)] disabled:opacity-60"
              placeholder="邮件主题"
            />
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-0.5 px-4 py-1.5 border-b border-[var(--color-border-default)]">
          <ToolbarButton icon={<Bold size={15} />} title="加粗" disabled={sending} onClick={() => execCommand('bold')} />
          <ToolbarButton icon={<Italic size={15} />} title="斜体" disabled={sending} onClick={() => execCommand('italic')} />
          <ToolbarButton icon={<Underline size={15} />} title="下划线" disabled={sending} onClick={() => execCommand('underline')} />
          <div className="w-px h-4 bg-[var(--color-border-default)] mx-1" />
          <ToolbarButton icon={<List size={15} />} title="列表" disabled={sending} onClick={() => execCommand('insertUnorderedList')} />
          <ToolbarButton icon={<Quote size={15} />} title="引用" disabled={sending} onClick={() => execCommand('formatBlock', 'blockquote')} />
          <ToolbarButton icon={<Link size={15} />} title="链接" disabled={sending} onClick={() => {
            const url = prompt('输入链接地址：');
            if (url) execCommand('createLink', url);
          }} />
          <div className="w-px h-4 bg-[var(--color-border-default)] mx-1" />
          <ToolbarButton icon={<Paperclip size={15} />} title="附件选择将在后续版本接入" disabled onClick={() => {
            store.addToast({ message: '发信附件选择将在后续版本接入', type: 'info' });
          }} />
        </div>

        {/* Editor */}
        <div className="flex-1 overflow-y-auto min-h-[160px]">
          <div
            ref={editorRef}
            contentEditable={!sending}
            suppressContentEditableWarning
            className="tiptap"
            onInput={e => setBody((e.target as HTMLDivElement).innerHTML)}
            style={{ minHeight: '160px' }}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--color-border-default)]">
          <button
            onClick={() => void handleSend()}
            disabled={!hasAccounts || sending}
            title={hasAccounts ? '通过 SMTP 发送' : '请先添加账号'}
            className="flex items-center gap-2 px-4 py-2 rounded-[var(--radius-button)] bg-[var(--color-accent)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] transition-smooth focus-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[var(--color-accent)]"
          >
            {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            {sending ? '正在发送…' : '发送'}
          </button>
          <button
            onClick={() => store.closeCompose()}
            disabled={sending}
            className="px-4 py-2 rounded-[var(--radius-button)] text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-smooth disabled:opacity-40"
          >
            丢弃
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

function ToolbarButton({ icon, title, onClick, disabled }: { icon: React.ReactNode; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] transition-smooth disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {icon}
    </button>
  );
}
