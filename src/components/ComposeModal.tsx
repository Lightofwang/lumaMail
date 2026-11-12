import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Bold, Italic, Underline, List, Link, Quote, Send, Save, Paperclip, UserPlus } from 'lucide-react';
import { useMailStore } from '@/store/mailStore';
import { sanitizeComposeHtml } from '@/lib/sanitizeHtml';
import { Contact } from '@/types';
import { ConfirmDialog } from '@/components/ConfirmDialog';

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
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
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

  const openLinkDialog = () => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && editorRef.current?.contains(selection.anchorNode)) {
      savedRangeRef.current = selection.getRangeAt(0).cloneRange();
    } else {
      savedRangeRef.current = null;
    }
    setLinkValue('');
    setLinkError(null);
    setLinkOpen(true);
  };

  const applyLink = () => {
    const url = linkValue.trim();
    if (!url) {
      setLinkError('请输入链接地址');
      return;
    }
    const selection = window.getSelection();
    const range = savedRangeRef.current;
    if (selection && range) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    editorRef.current?.focus();
    document.execCommand('createLink', false, url);
    setLinkOpen(false);
    setLinkValue('');
  };

  return (
    <>
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, scale: 0.98, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: 6 }}
          transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
          className="compose-card fixed bottom-4 right-4 z-50 flex max-h-[80vh] flex-col overflow-hidden rounded-[16px] border border-[rgba(0,0,0,0.05)] bg-white shadow-[var(--shadow-pop)]"
          role="dialog"
          aria-modal="false"
          aria-label="新邮件"
        >
          <div className="flex h-[52px] flex-shrink-0 items-center justify-between gap-3 border-b border-[rgba(0,0,0,0.06)] px-5">
            <div className="min-w-0">
              <h2 className="text-[17px] font-semibold leading-6 text-[var(--color-text-primary)]">新邮件</h2>
              {account && (
                <p className="truncate text-[12px] text-[var(--color-text-tertiary)]">发件账号：{account.email}</p>
              )}
            </div>
            <div className="flex flex-shrink-0 items-center gap-0.5">
              <button
                onClick={handleSaveDraft}
                disabled={!hasAccounts || sending}
                className="icon-btn"
                title={hasAccounts ? '保存本地草稿' : '请先添加账号'}
                aria-label="保存草稿"
              >
                <Save size={16} />
              </button>
              <button
                onClick={() => store.closeCompose()}
                disabled={sending}
                className="icon-btn"
                title="关闭 (Esc)"
                aria-label="关闭写信"
              >
                <X size={17} />
              </button>
            </div>
          </div>

          {!hasAccounts && (
            <div className="mx-4 mt-3 flex items-start gap-2 rounded-[10px] bg-[var(--color-notice-bg)] px-3 py-2.5">
              <UserPlus size={15} className="mt-0.5 flex-shrink-0 text-[var(--color-warning)]" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-[var(--color-text-secondary)]">还没有账号，添加账号后才能发送邮件。</p>
                <button
                  onClick={() => store.openAccountForm()}
                  className="mt-0.5 text-[13px] text-[var(--color-link)] hover:underline"
                >
                  去添加账号
                </button>
              </div>
            </div>
          )}

          <div className="flex-shrink-0 px-5">
            <FieldRow label="收件人">
              <input
                type="text"
                value={to}
                onChange={e => setTo(e.target.value)}
                disabled={sending}
                className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--color-text-tertiary)] disabled:opacity-60"
                placeholder="输入邮箱地址，多个用逗号分隔"
              />
              <div className="flex flex-shrink-0 items-center gap-1">
                {!showCc && (
                  <button onClick={() => setShowCc(true)} disabled={sending} className="btn-link text-[12px]">抄送</button>
                )}
                {!showBcc && (
                  <button onClick={() => setShowBcc(true)} disabled={sending} className="btn-link text-[12px]">密送</button>
                )}
              </div>
            </FieldRow>

            {showCc && (
              <FieldRow label="抄送">
                <input
                  type="text"
                  value={cc}
                  onChange={e => setCc(e.target.value)}
                  disabled={sending}
                  className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--color-text-tertiary)] disabled:opacity-60"
                  placeholder="抄送"
                />
                <button
                  onClick={() => { setShowCc(false); setCc(''); }}
                  disabled={sending}
                  className="icon-btn h-7 w-7"
                  aria-label="移除抄送"
                >
                  <X size={14} />
                </button>
              </FieldRow>
            )}

            {showBcc && (
              <FieldRow label="密送">
                <input
                  type="text"
                  value={bcc}
                  onChange={e => setBcc(e.target.value)}
                  disabled={sending}
                  className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--color-text-tertiary)] disabled:opacity-60"
                  placeholder="密送"
                />
                <button
                  onClick={() => { setShowBcc(false); setBcc(''); }}
                  disabled={sending}
                  className="icon-btn h-7 w-7"
                  aria-label="移除密送"
                >
                  <X size={14} />
                </button>
              </FieldRow>
            )}

            <FieldRow label="主题" noBorder>
              <input
                type="text"
                value={subject}
                onChange={e => setSubject(e.target.value)}
                disabled={sending}
                className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--color-text-tertiary)] disabled:opacity-60"
                placeholder="邮件主题"
              />
            </FieldRow>
          </div>

          <div className="flex flex-shrink-0 items-center gap-0.5 border-y border-[rgba(0,0,0,0.06)] px-4 py-1.5">
            <ToolbarButton icon={<Bold size={15} />} title="加粗" disabled={sending} onClick={() => execCommand('bold')} />
            <ToolbarButton icon={<Italic size={15} />} title="斜体" disabled={sending} onClick={() => execCommand('italic')} />
            <ToolbarButton icon={<Underline size={15} />} title="下划线" disabled={sending} onClick={() => execCommand('underline')} />
            <div className="mx-1 h-4 w-px bg-[rgba(0,0,0,0.08)]" />
            <ToolbarButton icon={<List size={15} />} title="列表" disabled={sending} onClick={() => execCommand('insertUnorderedList')} />
            <ToolbarButton icon={<Quote size={15} />} title="引用" disabled={sending} onClick={() => execCommand('formatBlock', 'blockquote')} />
            <ToolbarButton icon={<Link size={15} />} title="链接" disabled={sending} onClick={openLinkDialog} />
            <div className="mx-1 h-4 w-px bg-[rgba(0,0,0,0.08)]" />
            <ToolbarButton icon={<Paperclip size={15} />} title="附件选择将在后续版本接入" disabled onClick={() => {
              store.addToast({ message: '发信附件选择将在后续版本接入', type: 'info' });
            }} />
          </div>

          <div className="min-h-[160px] flex-1 overflow-y-auto">
            <div
              ref={editorRef}
              contentEditable={!sending}
              suppressContentEditableWarning
              className="tiptap"
              onInput={e => setBody((e.target as HTMLDivElement).innerHTML)}
              style={{ minHeight: '160px' }}
            />
          </div>

          <div className="flex flex-shrink-0 items-center justify-between border-t border-[rgba(0,0,0,0.06)] px-5 py-3">
            <button
              onClick={() => void handleSend()}
              disabled={!hasAccounts || sending}
              title={hasAccounts ? '通过 SMTP 发送' : '请先添加账号'}
              className="btn btn-primary"
            >
              <Send size={15} />
              {sending ? '正在发送…' : '发送'}
            </button>
            <button onClick={() => store.closeCompose()} disabled={sending} className="btn btn-ghost">
              丢弃
            </button>
          </div>
        </motion.div>
      </AnimatePresence>

      <ConfirmDialog
        open={linkOpen}
        title="插入链接"
        message="链接会插入到当前选中的文字上。"
        okText="插入"
        error={linkError}
        input={{
          label: '链接地址',
          placeholder: 'https://example.com',
          value: linkValue,
          onChange: setLinkValue,
        }}
        onConfirm={applyLink}
        onCancel={() => {
          setLinkOpen(false);
          setLinkValue('');
          setLinkError(null);
        }}
      />
    </>
  );
}

function FieldRow({ label, children, noBorder }: {
  label: string;
  children: React.ReactNode;
  noBorder?: boolean;
}) {
  return (
    <div
      className={`flex min-h-[44px] items-center gap-3 transition-colors focus-within:bg-[var(--color-fill)] ${
        noBorder ? '' : 'border-b border-[rgba(0,0,0,0.06)]'
      }`}
    >
      <span className="w-10 flex-shrink-0 text-[13px] text-[var(--color-text-tertiary)]">{label}</span>
      {children}
    </div>
  );
}

function ToolbarButton({ icon, title, onClick, disabled }: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="icon-btn h-7 w-7"
      aria-label={title}
    >
      {icon}
    </button>
  );
}
