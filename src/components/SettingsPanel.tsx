import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Palette, Type, Users, Server, Shield, UserPlus, Trash2 } from 'lucide-react';
import { useMailStore } from '@/store/mailStore';
import { providerLabel } from '@/lib/providers';
import { DensityMode } from '@/types';

type SettingsTab = 'appearance' | 'signature' | 'accounts' | 'server';

export function SettingsPanel() {
  const store = useMailStore();
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');

  const tabs = [
    { id: 'appearance' as const, label: '外观', icon: <Palette size={16} /> },
    { id: 'signature' as const, label: '签名', icon: <Signature size={16} /> },
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
            className="fixed inset-0 bg-black/20 z-40"
            onClick={() => store.closeSettings()}
          />
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            className="fixed top-0 right-0 bottom-0 w-[520px] bg-white shadow-[var(--shadow-dropdown)] border-l border-[var(--color-border-default)] z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border-default)]">
              <h2 className="text-base font-semibold text-[var(--color-text-primary)]">设置</h2>
              <button
                onClick={() => store.closeSettings()}
                className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-hover)] transition-smooth"
              >
                <X size={18} />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1 px-6 py-3 border-b border-[var(--color-border-default)]">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-tag)] text-sm font-medium transition-smooth ${
                    activeTab === tab.id
                      ? 'bg-[var(--color-accent)] text-white'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {activeTab === 'appearance' && <AppearanceSettings />}
              {activeTab === 'signature' && <SignatureSettings />}
              {activeTab === 'accounts' && <AccountSettings />}
              {activeTab === 'server' && <ServerSettings />}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function AppearanceSettings() {
  const store = useMailStore();

  return (
    <div className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">列表密度</label>
        <div className="flex gap-2">
          {(['comfortable', 'compact'] as DensityMode[]).map(mode => (
            <button
              key={mode}
              onClick={() => store.setDensity(mode)}
              className={`flex-1 px-4 py-2.5 rounded-[var(--radius-button)] border text-sm font-medium transition-smooth ${
                store.settings.density === mode
                  ? 'border-[var(--color-accent)] bg-[var(--color-bg-accent-10)] text-[var(--color-accent)]'
                  : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              {mode === 'comfortable' ? '舒适 (56px)' : '紧凑 (44px)'}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">
          正文字号：{store.settings.fontSize}px
        </label>
        <input
          type="range"
          min={12}
          max={18}
          step={1}
          value={store.settings.fontSize}
          onChange={e => store.setFontSize(Number(e.target.value))}
          className="w-full accent-[var(--color-accent)]"
        />
        <div className="flex justify-between text-xs text-[var(--color-text-tertiary)] mt-1">
          <span>12px</span>
          <span>18px</span>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">主题</label>
        <div className="flex gap-2">
          <div className="flex-1 px-4 py-2.5 rounded-[var(--radius-button)] border-2 border-[var(--color-accent)] bg-[var(--color-bg-accent-10)] text-sm font-medium text-[var(--color-accent)]">
            ☀️ 浅色
          </div>
          <div className="flex-1 px-4 py-2.5 rounded-[var(--radius-button)] border border-[var(--color-border-default)] text-sm font-medium text-[var(--color-text-tertiary)] cursor-not-allowed opacity-50">
            🌙 深色（即将推出）
          </div>
        </div>
      </div>

      <div className="pt-4 border-t border-[var(--color-border-default)]">
        <button
          onClick={() => {
            if (confirm('确定要清空本地数据吗？已配置的账号、系统凭据管理器中的密码、本地草稿与偏好都会被删除，应用将回到空邮箱状态。')) {
              void store.clearLocalData();
            }
          }}
          className="w-full px-4 py-2.5 rounded-[var(--radius-button)] border border-[var(--color-danger,#dc2626)] text-sm font-medium text-[var(--color-danger,#dc2626)] hover:bg-[var(--color-danger,#dc2626)]/5 transition-smooth"
        >
          清空本地数据
        </button>
        <p className="text-xs text-[var(--color-text-tertiary)] mt-2">
          删除已保存的账号配置、系统凭据管理器中的密码、本地草稿与界面偏好。服务器上的邮件不会被删除。
        </p>
      </div>
    </div>
  );
}

function SignatureSettings() {
  const store = useMailStore();
  const currentAccount = store.accounts.find(a => a.id === store.currentAccountId);
  const [signature, setSignature] = useState(currentAccount?.signature || '');

  if (!currentAccount) {
    return (
      <div className="space-y-4">
        <SettingsEmptyState
          title="还没有账号"
          description="添加账号后即可设置邮件签名。"
          onAdd={() => store.openAccountForm()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">
          当前账号：{currentAccount.name} ({currentAccount.email})
        </label>
        <textarea
          value={signature}
          onChange={e => setSignature(e.target.value)}
          rows={6}
          className="w-full px-3 py-2 rounded-[var(--radius-button)] border border-[var(--color-border-default)] text-sm resize-none outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-bg-accent-10)] transition-smooth"
          placeholder="输入你的邮件签名..."
        />
      </div>
      <button
        onClick={() => {
          store.addToast({ message: '签名保存将在后续版本接入，目前不会写入服务器', type: 'info' });
        }}
        className="px-4 py-2 rounded-[var(--radius-button)] bg-[var(--color-accent)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] transition-smooth"
      >
        保存签名
      </button>
    </div>
  );
}

function AccountSettings() {
  const store = useMailStore();
  const [removingId, setRemovingId] = useState<string | null>(null);

  const handleRemove = async (accountId: string, email: string) => {
    if (!confirm(`确定要删除账号 ${email} 吗？对应的服务器密码/授权码也会从系统凭据管理器移除，本地邮件缓存将被清空。`)) {
      return;
    }
    setRemovingId(accountId);
    try {
      await store.removeAccount(accountId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除账号失败，请稍后重试';
      store.addToast({ message, type: 'error' });
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--color-text-secondary)]">管理你的邮箱账号</p>
      {store.accounts.length === 0 && (
        <SettingsEmptyState
          title="还没有账号"
          description="添加账号后开始收发邮件。"
          onAdd={() => store.openAccountForm()}
        />
      )}
      {store.accounts.map(account => (
        <div
          key={account.id}
          className={`flex items-center gap-3 p-4 rounded-[var(--radius-card)] border transition-smooth ${
            account.id === store.currentAccountId
              ? 'border-[var(--color-accent)] bg-[var(--color-bg-accent-10)]'
              : 'border-[var(--color-border-default)] hover:bg-[var(--color-bg-hover)]'
          }`}
        >
          <div
            className="w-10 h-10 rounded-full bg-gradient-to-br flex items-center justify-center text-white font-bold flex-shrink-0"
            style={{
              backgroundImage: `linear-gradient(135deg, ${account.avatarColors[0]}, ${account.avatarColors[1]})`,
            }}
          >
            {account.name[0]}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[var(--color-text-primary)] text-left">{account.name}</div>
            <div className="text-xs text-[var(--color-text-tertiary)] truncate text-left">{account.email}</div>
          </div>
          <div className="text-xs text-[var(--color-text-tertiary)]">{providerLabel(account.provider)}</div>
          {account.id === store.currentAccountId && (
            <span className="text-xs font-medium text-[var(--color-accent)]">当前</span>
          )}
          <button
            onClick={() => void handleRemove(account.id, account.email)}
            disabled={removingId === account.id}
            className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger,#dc2626)] transition-smooth disabled:opacity-40"
            title="删除账号"
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button
        onClick={() => store.openAccountForm()}
        className="w-full px-4 py-2.5 rounded-[var(--radius-button)] border border-dashed border-[var(--color-border-default)] text-sm text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-smooth"
      >
        + 添加账号
      </button>
      <p className="text-xs text-[var(--color-text-tertiary)]">
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
      <div className="space-y-6">
        <SettingsEmptyState
          title="还没有账号"
          description="添加账号后可查看 IMAP / SMTP 服务器配置。"
          onAdd={() => store.openAccountForm()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-button)] bg-[var(--color-bg-accent-10)] border border-[var(--color-accent)]/20">
        <Shield size={16} className="text-[var(--color-accent)]" />
        <span className="text-xs text-[var(--color-text-secondary)] font-medium">
          {providerLabel(currentAccount.provider)} · 强制加密连接
        </span>
      </div>

      <div>
        <h3 className="text-sm font-medium text-[var(--color-text-primary)] mb-3">IMAP 收件服务器</h3>
        <div className="space-y-3">
          <SettingsField label="服务器地址" value={currentAccount.imap.host} readOnly />
          <SettingsField label="端口" value={String(currentAccount.imap.port)} readOnly />
          <SettingsField label="加密方式" value="SSL/TLS" readOnly />
          <SettingsField label="用户名" value={currentAccount.username} readOnly />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-[var(--color-text-primary)] mb-3">SMTP 发件服务器</h3>
        <div className="space-y-3">
          <SettingsField label="服务器地址" value={currentAccount.smtp.host} readOnly />
          <SettingsField label="端口" value={String(currentAccount.smtp.port)} readOnly />
          <SettingsField
            label="加密方式"
            value={currentAccount.smtp.security === 'starttls' ? 'STARTTLS' : 'SSL/TLS'}
            readOnly
          />
          <SettingsField label="用户名" value={currentAccount.username} readOnly />
        </div>
      </div>

      <p className="text-xs text-[var(--color-text-tertiary)]">
        密码/授权码保存在系统凭据管理器中，应用不会在此显示或写入配置文件。当前版本使用密码/授权码登录，暂不支持 OAuth。
      </p>
    </div>
  );
}

function SettingsEmptyState({ title, description, onAdd }: {
  title: string; description: string; onAdd: () => void;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-default)] bg-[var(--color-bg-sidebar)] px-4 py-6 text-center">
      <p className="text-sm font-medium text-[var(--color-text-primary)]">{title}</p>
      <p className="text-xs text-[var(--color-text-tertiary)] mt-1">{description}</p>
      <button
        onClick={onAdd}
        className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius-button)] bg-[var(--color-accent)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] transition-smooth focus-ring"
      >
        <UserPlus size={15} />
        添加账号
      </button>
    </div>
  );
}

function SettingsField({ label, value, readOnly }: { label: string; value: string; readOnly?: boolean }) {
  return (
    <div>
      <label className="block text-xs text-[var(--color-text-tertiary)] mb-1">{label}</label>
      <input
        type="text"
        value={value}
        readOnly={readOnly}
        className={`w-full px-3 py-2 rounded-[var(--radius-button)] border text-sm outline-none transition-smooth ${
          readOnly
            ? 'bg-[var(--color-bg-sidebar)] border-[var(--color-border-default)] text-[var(--color-text-secondary)]'
            : 'border-[var(--color-border-default)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-bg-accent-10)]'
        }`}
      />
    </div>
  );
}

// Signature icon since lucide doesn't have one
function Signature({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17h4l3-8 4 16 3-8h4" />
    </svg>
  );
}
