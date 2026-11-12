import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Palette, PenLine, Users, Server, Shield, UserPlus, Trash2, Sun, Moon } from 'lucide-react';
import { useMailStore } from '@/store/mailStore';
import { providerLabel } from '@/lib/providers';
import { DensityMode } from '@/types';

type SettingsTab = 'appearance' | 'signature' | 'accounts' | 'server';

export function SettingsPanel() {
  const store = useMailStore();
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');

  const tabs = [
    { id: 'appearance' as const, label: '外观', icon: <Palette size={16} /> },
    { id: 'signature' as const, label: '签名', icon: <PenLine size={16} /> },
    { id: 'accounts' as const, label: '账号', icon: <Users size={16} /> },
    { id: 'server' as const, label: '服务器', icon: <Server size={16} /> },
  ];

  return (
    <AnimatePresence>
      {store.isSettingsOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="dialog-overlay fixed inset-0 z-40"
            onClick={() => store.closeSettings()}
          />
          <motion.div
            initial={{ opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 6 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            className="settings-drawer fixed top-0 right-0 bottom-0 z-50 flex flex-col overflow-hidden rounded-l-[16px] bg-white shadow-[var(--shadow-pop)]"
            role="dialog"
            aria-modal="true"
            aria-label="设置"
          >
            <div className="flex h-[52px] flex-shrink-0 items-center justify-between px-6">
              <h2 className="text-[17px] font-semibold text-[var(--color-text-primary)]">设置</h2>
              <button onClick={() => store.closeSettings()} className="icon-btn" aria-label="关闭设置">
                <X size={18} />
              </button>
            </div>

            <div className="flex flex-shrink-0 items-center gap-1 px-6 pb-3">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex h-9 items-center gap-1.5 rounded-[10px] px-3 text-[14px] transition-[background-color,color] duration-150 ${
                    activeTab === tab.id
                      ? 'bg-[var(--color-bg-selected)] font-medium text-[var(--color-text-primary)]'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-[780px] px-8 pb-[72px] pt-6">
                {activeTab === 'appearance' && <AppearanceSettings />}
                {activeTab === 'signature' && <SignatureSettings />}
                {activeTab === 'accounts' && <AccountSettings />}
                {activeTab === 'server' && <ServerSettings />}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h3 className="section-caption mb-2 px-1">{title}</h3>
      {children}
    </section>
  );
}

function SettingsRow({ label, hint, children, last }: {
  label: string;
  hint?: string;
  children?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={`flex min-h-[52px] items-center justify-between gap-4 px-4 py-2.5 ${
        last ? '' : 'border-b border-[rgba(0,0,0,0.06)]'
      }`}
    >
      <div className="min-w-0">
        <div className="text-[14px] text-[var(--color-text-primary)]">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">{hint}</div>}
      </div>
      {children && <div className="flex flex-shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

function AppearanceSettings() {
  const store = useMailStore();

  return (
    <div>
      <SettingsSection title="显示">
        <div className="group-card overflow-hidden">
          <SettingsRow label="列表密度" hint="影响邮件列表的行高">
            <div className="flex gap-1 rounded-[10px] bg-[rgba(0,0,0,0.04)] p-1">
              {(['comfortable', 'compact'] as DensityMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => store.setDensity(mode)}
                  className={`h-7 rounded-[8px] px-3 text-[13px] transition-[background-color,color] duration-150 ${
                    store.settings.density === mode
                      ? 'bg-white font-medium text-[var(--color-text-primary)]'
                      : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                  }`}
                >
                  {mode === 'comfortable' ? '舒适' : '紧凑'}
                </button>
              ))}
            </div>
          </SettingsRow>

          <div className="border-b border-[rgba(0,0,0,0.06)] px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[14px] text-[var(--color-text-primary)]">正文字号</span>
              <span className="text-[13px] text-[var(--color-text-tertiary)]">{store.settings.fontSize}px</span>
            </div>
            <input
              type="range"
              min={12}
              max={18}
              step={1}
              value={store.settings.fontSize}
              onChange={e => store.setFontSize(Number(e.target.value))}
              aria-label="正文字号"
            />
            <div className="mt-1 flex justify-between text-[12px] text-[var(--color-text-tertiary)]">
              <span>12px</span>
              <span>18px</span>
            </div>
          </div>

          <SettingsRow label="主题" last>
            <div className="flex gap-1 rounded-[10px] bg-[rgba(0,0,0,0.04)] p-1">
              <span className="flex h-7 items-center gap-1.5 rounded-[8px] bg-white px-3 text-[13px] font-medium text-[var(--color-text-primary)]">
                <Sun size={14} />
                浅色
              </span>
              <span className="flex h-7 cursor-not-allowed items-center gap-1.5 px-3 text-[13px] text-[var(--color-text-tertiary)] opacity-60">
                <Moon size={14} />
                深色
              </span>
            </div>
          </SettingsRow>
        </div>
      </SettingsSection>

      <SettingsSection title="本地数据">
        <div className="group-card overflow-hidden">
          <SettingsRow label="清空本地数据" hint="账号配置、系统凭据中的密码、草稿与界面偏好都会被删除" last>
            <button
              onClick={() =>
                void store.requestConfirm({
                  title: '清空本地数据',
                  message:
                    '清空后，已配置的账号、系统凭据管理器中的密码、本地草稿与偏好都会被删除，应用回到空邮箱状态；服务器上的邮件不受影响。',
                  okText: '清空',
                  pendingText: '清空中…',
                  danger: true,
                  action: () => store.clearLocalData(),
                })
              }
              className="btn btn-danger-text"
            >
              清空本地数据
            </button>
          </SettingsRow>
        </div>
        <p className="mt-2 px-1 text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">
          只删除本机保存的配置与凭据，不会影响邮箱服务器上的邮件。
        </p>
      </SettingsSection>
    </div>
  );
}

function SignatureSettings() {
  const store = useMailStore();
  const currentAccount = store.accounts.find(a => a.id === store.currentAccountId);
  const [signature, setSignature] = useState(currentAccount?.signature || '');

  if (!currentAccount) {
    return (
      <SettingsEmptyState
        title="还没有账号"
        description="添加账号后即可设置邮件签名。"
        onAdd={() => store.openAccountForm()}
      />
    );
  }

  return (
    <div>
      <SettingsSection title="邮件签名">
        <div className="group-card overflow-hidden">
          <div className="border-b border-[rgba(0,0,0,0.06)] px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[14px] text-[var(--color-text-primary)]">{currentAccount.name}</span>
              <span className="truncate text-[12px] text-[var(--color-text-tertiary)]">{currentAccount.email}</span>
            </div>
          </div>
          <div className="p-4">
            <textarea
              value={signature}
              onChange={e => setSignature(e.target.value)}
              rows={6}
              className="input input-on-card w-full resize-none"
              placeholder="输入你的邮件签名…"
            />
          </div>
        </div>
        <p className="mt-2 px-1 text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">
          签名保存将在后续版本接入，目前不会写入服务器。
        </p>
      </SettingsSection>
      <button
        onClick={() => {
          store.addToast({ message: '签名保存将在后续版本接入，目前不会写入服务器', type: 'info' });
        }}
        className="btn btn-primary"
      >
        保存签名
      </button>
    </div>
  );
}

function AccountSettings() {
  const store = useMailStore();

  const handleRemove = (accountId: string, email: string) => {
    void store.requestConfirm({
      title: '删除账号',
      message: `删除后，账号 ${email} 对应的服务器密码/授权码会从系统凭据管理器移除，本地邮件缓存也会被清空。`,
      okText: '删除账号',
      pendingText: '删除中…',
      danger: true,
      action: () => store.removeAccount(accountId),
    });
  };

  return (
    <div>
      <SettingsSection title="邮箱账号">
        {store.accounts.length === 0 ? (
          <SettingsEmptyState
            title="还没有账号"
            description="添加账号后开始收发邮件。"
            onAdd={() => store.openAccountForm()}
          />
        ) : (
          <div className="group-card overflow-hidden">
            {store.accounts.map((account, index) => (
              <div
                key={account.id}
                className={`flex min-h-[60px] items-center gap-3 px-4 py-2.5 ${
                  index === store.accounts.length - 1 ? '' : 'border-b border-[rgba(0,0,0,0.06)]'
                }`}
              >
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-fill)] text-[14px] font-semibold text-[var(--color-text-secondary)]">
                  {(account.name[0] ?? account.email[0] ?? '?').toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] text-[var(--color-text-primary)]">{account.name}</span>
                    {account.id === store.currentAccountId && <span className="badge">当前</span>}
                  </div>
                  <div className="truncate text-[12px] text-[var(--color-text-tertiary)]">{account.email}</div>
                </div>
                <span className="hidden text-[12px] text-[var(--color-text-tertiary)] sm:inline">
                  {providerLabel(account.provider)}
                </span>
                <button
                  onClick={() => handleRemove(account.id, account.email)}
                  className="btn btn-danger-text h-8 px-2"
                  title="删除账号"
                >
                  <Trash2 size={15} />
                  <span className="hidden sm:inline">删除</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <button onClick={() => store.openAccountForm()} className="btn btn-secondary h-10 w-full">
        <UserPlus size={16} />
        添加账号
      </button>

      <p className="mt-3 px-1 text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">
        密码/授权码只保存在系统凭据管理器（Windows 凭据管理器 / macOS 钥匙串），不会写入配置文件或浏览器存储。
      </p>
    </div>
  );
}

function ServerSettings() {
  const store = useMailStore();
  const currentAccount = store.accounts.find(a => a.id === store.currentAccountId);

  if (!currentAccount) {
    return (
      <SettingsEmptyState
        title="还没有账号"
        description="添加账号后可查看 IMAP / SMTP 服务器配置。"
        onAdd={() => store.openAccountForm()}
      />
    );
  }

  return (
    <div>
      <SettingsSection title="服务器">
        <div className="notice notice-neutral mb-3 flex items-center gap-2">
          <Shield size={16} className="flex-shrink-0" />
          <span className="text-[13px]">
            {providerLabel(currentAccount.provider)} · 强制加密连接
          </span>
        </div>

        <div className="group-card overflow-hidden">
          <SettingsRow label="IMAP 收件服务器" hint="SSL/TLS">
            <span className="text-[13px] text-[var(--color-text-secondary)]">
              {currentAccount.imap.host}:{currentAccount.imap.port}
            </span>
          </SettingsRow>
          <SettingsRow label="SMTP 发件服务器" hint={currentAccount.smtp.security === 'starttls' ? 'STARTTLS' : 'SSL/TLS'}>
            <span className="text-[13px] text-[var(--color-text-secondary)]">
              {currentAccount.smtp.host}:{currentAccount.smtp.port}
            </span>
          </SettingsRow>
          <SettingsRow label="登录用户名" last>
            <span className="truncate text-[13px] text-[var(--color-text-secondary)]">{currentAccount.username}</span>
          </SettingsRow>
        </div>
        <p className="mt-2 px-1 text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">
          密码/授权码保存在系统凭据管理器中，应用不会在此显示或写入配置文件。当前版本使用密码/授权码登录，暂不支持 OAuth。
        </p>
      </SettingsSection>
    </div>
  );
}

function SettingsEmptyState({ title, description, onAdd }: {
  title: string;
  description: string;
  onAdd: () => void;
}) {
  return (
    <div className="group-card px-6 py-10 text-center">
      <p className="text-[14px] font-medium text-[var(--color-text-primary)]">{title}</p>
      <p className="mt-1 text-[13px] text-[var(--color-text-tertiary)]">{description}</p>
      <button onClick={onAdd} className="btn btn-primary mt-4">
        <UserPlus size={16} />
        添加账号
      </button>
    </div>
  );
}
