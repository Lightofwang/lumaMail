import { useEffect, useId, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Server, ShieldCheck, Eye, EyeOff, AlertCircle, ChevronDown, Check } from 'lucide-react';
import { useMailStore } from '@/store/mailStore';
import { PROVIDERS, providerPreset } from '@/lib/providers';
import { toMailApiError } from '@/lib/mailApi';
import type { AccountConfig, ProviderId, ServerSecurity } from '@/types';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidPort(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const port = Number(value);
  return port > 0 && port <= 65535;
}

interface FormError {
  message: string;
  detail?: string;
}

export function AccountSetupModal() {
  const store = useMailStore();
  const defaultPreset = PROVIDERS[0];

  const [provider, setProvider] = useState<ProviderId>(defaultPreset.id);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [imapHost, setImapHost] = useState(defaultPreset.imapHost);
  const [imapPort, setImapPort] = useState(defaultPreset.imapPort);
  const [smtpHost, setSmtpHost] = useState(defaultPreset.smtpHost);
  const [smtpPort, setSmtpPort] = useState(defaultPreset.smtpPort);
  const [smtpSecurity, setSmtpSecurity] = useState<ServerSecurity>(defaultPreset.smtpSecurity);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<FormError | null>(null);

  const preset = providerPreset(provider);

  // Never keep the password/authorization code in memory after the form closes.
  useEffect(() => {
    if (!store.isAccountFormOpen) {
      setSecret('');
      setShowSecret(false);
      setSubmitting(false);
      setFormError(null);
    }
  }, [store.isAccountFormOpen]);

  const emailValid = EMAIL_PATTERN.test(email.trim());
  const displayNameValid = displayName.trim().length > 0;
  const usernameValid = username.trim().length > 0;
  const secretValid = secret.trim().length > 0;
  const imapValid = imapHost.trim().length > 0 && isValidPort(imapPort);
  const smtpValid = smtpHost.trim().length > 0 && isValidPort(smtpPort);
  const formValid = emailValid && displayNameValid && usernameValid && secretValid && imapValid && smtpValid;

  const handleProviderChange = (value: ProviderId) => {
    const next = providerPreset(value);
    setProvider(value);
    setImapHost(next.imapHost);
    setImapPort(next.imapPort);
    setSmtpHost(next.smtpHost);
    setSmtpPort(next.smtpPort);
    setSmtpSecurity(next.smtpSecurity);
    setFormError(null);
  };

  const handleEmailChange = (value: string) => {
    setEmail(value);
    if (!usernameTouched) setUsername(value);
    setFormError(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!formValid || submitting) return;

    const config: AccountConfig = {
      id: '',
      provider,
      email: email.trim(),
      displayName: displayName.trim(),
      username: (username.trim() || email.trim()),
      imap: {
        host: imapHost.trim(),
        port: Number(imapPort),
        security: 'ssl',
      },
      smtp: {
        host: smtpHost.trim(),
        port: Number(smtpPort),
        security: smtpSecurity,
      },
    };

    setSubmitting(true);
    setFormError(null);
    try {
      // `addAccount` runs account_test first and only persists after it passes.
      await store.addAccount(config, secret);
      setSecret('');
      store.closeAccountForm();
    } catch (error) {
      const mailError = toMailApiError(error);
      setFormError({ message: mailError.message, detail: mailError.detail });
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    if (!submitting) store.closeAccountForm();
  };

  return (
    <AnimatePresence>
      {store.isAccountFormOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="dialog-overlay fixed inset-0 z-[200]"
            onClick={close}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 6 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-form-title"
            className="dialog-card fixed top-1/2 left-1/2 z-[200] flex max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden"
          >
            <div className="flex flex-shrink-0 items-center justify-between gap-3 px-6 pb-3 pt-5">
              <div className="flex items-center gap-2">
                <Server size={18} className="text-[var(--color-text-secondary)]" />
                <h2 id="account-form-title" className="text-[17px] font-semibold leading-6 text-[var(--color-text-primary)]">
                  添加账号
                </h2>
              </div>
              <button onClick={close} disabled={submitting} className="icon-btn" aria-label="关闭">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-col">
              <div className="flex-1 space-y-4 overflow-y-auto px-6 pb-4">
                <div className="notice notice-neutral flex items-start gap-2">
                  <ShieldCheck size={16} className="mt-0.5 flex-shrink-0" />
                  <p className="text-[13px] leading-relaxed">
                    密码或授权码仅保存在系统凭据管理器，不会写入配置文件与日志。连接使用 SSL/TLS 加密。
                  </p>
                </div>

                <FieldGroup label="服务商">
                  <SelectMenu
                    label="服务商"
                    value={provider}
                    options={PROVIDERS.map(p => ({ value: p.id, label: p.label }))}
                    onChange={handleProviderChange}
                    disabled={submitting}
                  />
                </FieldGroup>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="显示名称">
                    <input
                      type="text"
                      value={displayName}
                      onChange={e => { setDisplayName(e.target.value); setFormError(null); }}
                      placeholder="你的名字"
                      autoComplete="off"
                      disabled={submitting}
                      className="input disabled:opacity-60"
                    />
                  </Field>
                  <Field label="邮箱地址">
                    <input
                      type="email"
                      value={email}
                      onChange={e => handleEmailChange(e.target.value)}
                      placeholder="you@example.com"
                      autoComplete="off"
                      disabled={submitting}
                      className="input disabled:opacity-60"
                    />
                  </Field>
                </div>

                <Field label="登录用户名（默认与邮箱相同）">
                  <input
                    type="text"
                    value={username}
                    onChange={e => { setUsername(e.target.value); setUsernameTouched(true); setFormError(null); }}
                    placeholder="user@example.com"
                    autoComplete="off"
                    disabled={submitting}
                    className="input disabled:opacity-60"
                  />
                </Field>

                <Field label="密码或授权码">
                  <div className="relative">
                    <input
                      type={showSecret ? 'text' : 'password'}
                      value={secret}
                      onChange={e => { setSecret(e.target.value); setFormError(null); }}
                      placeholder="输入密码或授权码"
                      autoComplete="new-password"
                      disabled={submitting}
                      className="input pr-11 disabled:opacity-60"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecret(v => !v)}
                      disabled={submitting}
                      className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-[8px] text-[var(--color-text-tertiary)] transition-colors duration-150 hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
                      aria-label={showSecret ? '隐藏密码' : '显示密码'}
                    >
                      {showSecret ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                  {preset.hint && (
                    <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">{preset.hint}</p>
                  )}
                </Field>

                <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
                  <Field label="IMAP 服务器（SSL/TLS）">
                    <input
                      type="text"
                      value={imapHost}
                      onChange={e => { setImapHost(e.target.value); setFormError(null); }}
                      placeholder="imap.example.com"
                      autoComplete="off"
                      disabled={submitting}
                      className="input disabled:opacity-60"
                    />
                  </Field>
                  <Field label="IMAP 端口">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={imapPort}
                      onChange={e => { setImapPort(e.target.value); setFormError(null); }}
                      placeholder="993"
                      disabled={submitting}
                      className="input disabled:opacity-60"
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
                  <Field label="SMTP 服务器">
                    <input
                      type="text"
                      value={smtpHost}
                      onChange={e => { setSmtpHost(e.target.value); setFormError(null); }}
                      placeholder="smtp.example.com"
                      autoComplete="off"
                      disabled={submitting}
                      className="input disabled:opacity-60"
                    />
                  </Field>
                  <Field label="SMTP 端口">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={smtpPort}
                      onChange={e => { setSmtpPort(e.target.value); setFormError(null); }}
                      placeholder="465"
                      disabled={submitting}
                      className="input disabled:opacity-60"
                    />
                  </Field>
                </div>

                <FieldGroup label="SMTP 加密方式">
                  <SelectMenu
                    label="SMTP 加密方式"
                    value={smtpSecurity}
                    options={[
                      { value: 'ssl', label: 'SSL/TLS（隐式加密，常用 465）' },
                      { value: 'starttls', label: 'STARTTLS（常用 587）' },
                    ]}
                    onChange={next => { setSmtpSecurity(next); setFormError(null); }}
                    disabled={submitting}
                    placement="up"
                  />
                </FieldGroup>
              </div>

              <div className="flex-shrink-0 border-t border-[rgba(0,0,0,0.06)] px-6 py-4">
                {formError && (
                  <div className="notice notice-error mb-3 flex items-start gap-2">
                    <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium">{formError.message}</p>
                      {formError.detail && (
                        <p className="mt-1 break-words text-[12px] text-[var(--color-text-tertiary)]">{formError.detail}</p>
                      )}
                    </div>
                  </div>
                )}
                <p className="mb-3 text-[12px] text-[var(--color-text-tertiary)]">
                  保存前会先验证 IMAP 收件与 SMTP 发件连接，成功后才写入账号配置。
                </p>
                <div className="flex items-center justify-end gap-2">
                  <button type="button" onClick={close} disabled={submitting} className="btn btn-ghost">
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={!formValid || submitting}
                    title={formValid ? '验证并保存账号' : '请填写显示名称、邮箱、密码或授权码、服务器与端口'}
                    className="btn btn-primary"
                  >
                    {submitting ? '正在验证连接…' : '测试并保存'}
                  </button>
                </div>
              </div>
            </form>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] text-[var(--color-text-tertiary)]">{label}</span>
      {children}
    </label>
  );
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1.5 block text-[12px] text-[var(--color-text-tertiary)]">{label}</span>
      {children}
    </div>
  );
}

interface SelectOption<T extends string> {
  value: T;
  label: string;
}

/** 自绘下拉：按钮触发 + menu-panel，焦点始终留在触发按钮上，用 ↑/↓/Home/End 移动高亮。 */
function SelectMenu<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  placement = 'down',
}: {
  label: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  placement?: 'down' | 'up';
}) {
  const baseId = useId();
  const listId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options[selectedIndex];

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const openMenu = () => {
    setActiveIndex(selectedIndex);
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  const commit = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeMenu(true);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    if (!open) {
      if (
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Enter' ||
        event.key === ' '
      ) {
        event.preventDefault();
        event.stopPropagation();
        openMenu();
      }
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex(index => (index + 1) % options.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex(index => (index - 1 + options.length) % options.length);
        break;
      case 'Home':
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        event.stopPropagation();
        commit(activeIndex);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        className="input flex items-center justify-between gap-2 text-left disabled:opacity-60"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        aria-label={label}
        onClick={() => {
          if (open) closeMenu();
          else openMenu();
        }}
        onKeyDown={handleKeyDown}
      >
        <span className="truncate">{selected?.label ?? ''}</span>
        <ChevronDown
          size={16}
          className={`flex-shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-150 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          className={`menu-panel absolute left-0 right-0 z-20 ${
            placement === 'up' ? 'bottom-[calc(100%+4px)]' : 'top-[calc(100%+4px)]'
          }`}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                id={optionId(index)}
                type="button"
                role="option"
                aria-selected={isSelected}
                tabIndex={-1}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(index)}
                className={`flex h-9 w-full items-center justify-between gap-2 rounded-[8px] px-2.5 text-left text-[14px] ${
                  index === activeIndex ? 'bg-[var(--color-bg-hover)]' : ''
                }`}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && <Check size={16} className="flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
