import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Server, ShieldCheck, Eye, EyeOff, AlertCircle, Loader2 } from 'lucide-react';
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
            className="fixed inset-0 bg-black/20 z-50"
            onClick={close}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-form-title"
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[520px] max-w-[calc(100vw-32px)] max-h-[85vh] bg-white rounded-[var(--radius-card)] shadow-[var(--shadow-dropdown)] border border-[var(--color-border-default)] z-50 flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border-default)]">
              <div className="flex items-center gap-2">
                <Server size={18} className="text-[var(--color-accent)]" />
                <h2 id="account-form-title" className="text-base font-semibold text-[var(--color-text-primary)]">添加账号</h2>
              </div>
              <button
                onClick={close}
                disabled={submitting}
                className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-hover)] transition-smooth disabled:opacity-40"
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSubmit} noValidate className="flex flex-col min-h-0">
              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-[var(--radius-button)] bg-[var(--color-bg-accent-10)]">
                  <ShieldCheck size={16} className="text-[var(--color-accent)] flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                    密码或授权码仅保存在系统凭据管理器，不会写入配置文件与日志。连接使用 SSL/TLS 加密。
                  </p>
                </div>

                <Field label="服务商">
                  <select
                    value={provider}
                    onChange={e => handleProviderChange(e.target.value as ProviderId)}
                    disabled={submitting}
                    className="w-full px-3 py-2 rounded-[var(--radius-button)] border border-[var(--color-border-default)] bg-white text-sm outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-bg-accent-10)] transition-smooth disabled:opacity-60"
                  >
                    {PROVIDERS.map(p => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="显示名称">
                    <input
                      type="text"
                      value={displayName}
                      onChange={e => { setDisplayName(e.target.value); setFormError(null); }}
                      placeholder="你的名字"
                      autoComplete="off"
                      disabled={submitting}
                      className="w-full px-3 py-2 rounded-[var(--radius-button)] border border-[var(--color-border-default)] text-sm outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-bg-accent-10)] transition-smooth disabled:opacity-60"
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
                      className="w-full px-3 py-2 rounded-[var(--radius-button)] border border-[var(--color-border-default)] text-sm outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-bg-accent-10)] transition-smooth disabled:opacity-60"
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
                    className="w-full px-3 py-2 rounded-[var(--radius-button)] border border-[var(--color-border-default)] text-sm outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-bg-accent-10)] transition-smooth disabled:opacity-60"
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
                      className="w-full px-3 pr-10 py-2 rounded-[var(--radius-button)] border border-[var(--color-border-default)] text-sm outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-bg-accent-10)] transition-smooth disabled:opacity-60"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecret(v => !v)}
                      disabled={submitting}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-smooth disabled:opacity-40"
                      aria-label={showSecret ? '隐藏密码' : '显示密码'}
                    >
                      {showSecret ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                  {preset.hint && (
                    <p className="mt-1 text-[11px] text-[var(--color-text-tertiary)] leading-relaxed">{preset.hint}</p>
                  )}
                </Field>

                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <Field label="IMAP 服务器（SSL/TLS）">
                      <input
                        type="text"
                        value={imapHost}
                        onChange={e => { setImapHost(e.target.value); setFormError(null); }}
                        placeholder="imap.example.com"
                        autoComplete="off"
                        disabled={submitting}
                        className="w-full px-3 py-2 rounded-[var(--radius-button)] border border-[var(--color-border-default)] text-sm outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-bg-accent-10)] transition-smooth disabled:opacity-60"
                      />
                    </Field>
                  </div>
                  <Field label="IMAP 端口">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={imapPort}
                      onChange={e => { setImapPort(e.target.value); setFormError(null); }}
                      placeholder="993"
                      disabled={submitting}
                      className="w-full px-3 py-2 rounded-[var(--radius-button)] border border-[var(--color-border-default)] text-sm outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-bg-accent-10)] transition-smooth disabled:opacity-60"
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <Field label="SMTP 服务器">
                      <input
                        type="text"
                        value={smtpHost}
                        onChange={e => { setSmtpHost(e.target.value); setFormError(null); }}
                        placeholder="smtp.example.com"
                        autoComplete="off"
                        disabled={submitting}
                        className="w-full px-3 py-2 rounded-[var(--radius-button)] border border-[var(--color-border-default)] text-sm outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-bg-accent-10)] transition-smooth disabled:opacity-60"
                      />
                    </Field>
                  </div>
                  <Field label="SMTP 端口">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={smtpPort}
                      onChange={e => { setSmtpPort(e.target.value); setFormError(null); }}
                      placeholder="465"
                      disabled={submitting}
                      className="w-full px-3 py-2 rounded-[var(--radius-button)] border border-[var(--color-border-default)] text-sm outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-bg-accent-10)] transition-smooth disabled:opacity-60"
                    />
                  </Field>
                </div>

                <Field label="SMTP 加密方式">
                  <select
                    value={smtpSecurity}
                    onChange={e => { setSmtpSecurity(e.target.value as ServerSecurity); setFormError(null); }}
                    disabled={submitting}
                    className="w-full px-3 py-2 rounded-[var(--radius-button)] border border-[var(--color-border-default)] bg-white text-sm outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-bg-accent-10)] transition-smooth disabled:opacity-60"
                  >
                    <option value="ssl">SSL/TLS（隐式加密，常用 465）</option>
                    <option value="starttls">STARTTLS（常用 587）</option>
                  </select>
                </Field>
              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t border-[var(--color-border-default)]">
                {formError && (
                  <div className="flex items-start gap-2 mb-3 px-3 py-2.5 rounded-[var(--radius-button)] bg-[var(--color-error)]/10 border border-[var(--color-error)]/20">
                    <AlertCircle size={16} className="text-[var(--color-error)] flex-shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-[var(--color-error)]">{formError.message}</p>
                      {formError.detail && (
                        <p className="mt-1 text-[11px] text-[var(--color-text-tertiary)] break-words">{formError.detail}</p>
                      )}
                    </div>
                  </div>
                )}
                <p className="text-xs text-[var(--color-text-tertiary)] mb-3">
                  保存前会先验证 IMAP 收件与 SMTP 发件连接，成功后才写入账号配置。
                </p>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={close}
                    disabled={submitting}
                    className="px-4 py-2 rounded-[var(--radius-button)] text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-smooth disabled:opacity-40"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={!formValid || submitting}
                    title={formValid ? '验证并保存账号' : '请填写显示名称、邮箱、密码或授权码、服务器与端口'}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-[var(--radius-button)] bg-[var(--color-accent)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] transition-smooth focus-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[var(--color-accent)]"
                  >
                    {submitting && <Loader2 size={15} className="animate-spin" />}
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
      <span className="block text-xs text-[var(--color-text-tertiary)] mb-1">{label}</span>
      {children}
    </label>
  );
}
