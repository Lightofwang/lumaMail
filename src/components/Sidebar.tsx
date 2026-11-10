import { useState } from 'react';
import { motion } from 'motion/react';
import {
  Inbox, Star, Send, FileText, Archive, Trash2, Briefcase, User,
  Settings, ChevronDown, ChevronRight, PenSquare, Mail, Menu, UserPlus,
  ShieldAlert, Folder as FolderIcon,
} from 'lucide-react';
import { useMailStore } from '@/store/mailStore';
import { getInitials } from '@/lib/utils';

const iconMap: Record<string, React.ReactNode> = {
  inbox: <Inbox size={18} />,
  star: <Star size={18} />,
  send: <Send size={18} />,
  'file-text': <FileText size={18} />,
  archive: <Archive size={18} />,
  'trash-2': <Trash2 size={18} />,
  briefcase: <Briefcase size={18} />,
  user: <User size={18} />,
  junk: <ShieldAlert size={18} />,
  folder: <FolderIcon size={18} />,
};

export function Sidebar({ onManualToggle }: { onManualToggle?: () => void } = {}) {
  const store = useMailStore();
  const currentFolders = store.getCurrentFolders();
  const currentAccount = store.accounts.find(a => a.id === store.currentAccountId);
  const hasAccounts = store.accounts.length > 0;
  const collapsed = store.sidebarCollapsed;

  const handleToggle = () => {
    if (onManualToggle) onManualToggle();
    else store.toggleSidebar();
  };

  const mainFolders = currentFolders.filter(f =>
    ['inbox', 'starred', 'sent', 'drafts', 'junk', 'archive', 'trash'].includes(f.type)
  );
  const customFolders = currentFolders.filter(f => f.type === 'custom');

  return (
    <motion.aside
      animate={{ width: collapsed ? 72 : 248 }}
      transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
      className="flex flex-col h-full bg-[var(--color-bg-sidebar)] border-r border-[var(--color-border-default)]"
    >
      {/* Brand */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-[var(--color-border-default)]">
        <button
          onClick={handleToggle}
          className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] transition-smooth"
          title={collapsed ? '展开侧栏' : '折叠侧栏'}
        >
          <Menu size={18} />
        </button>
        <div
          className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#6366F1] to-[#8B5CF6] flex items-center justify-center flex-shrink-0"
        >
          <Mail size={16} className="text-white" />
        </div>
        {!collapsed && (
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="font-semibold text-[var(--color-text-primary)] text-[15px] whitespace-nowrap"
          >
            Luma Mail
          </motion.span>
        )}
      </div>

      {/* Compose button */}
      <div className="px-3 py-3">
        <button
          onClick={() => store.openCompose()}
          className={`flex items-center gap-2 w-full rounded-[var(--radius-button)] bg-[var(--color-accent)] text-white font-medium transition-smooth hover:bg-[var(--color-accent-hover)] focus-ring ${
            collapsed ? 'justify-center p-2.5' : 'px-4 py-2.5'
          }`}
          title="撰写邮件 (c)"
        >
          <PenSquare size={18} />
          {!collapsed && <span>撰写</span>}
        </button>
      </div>

      {/* Account switcher / empty-state guidance */}
      {!collapsed && (
        <div className="px-3 pb-2">
          {hasAccounts ? (
            <AccountSwitcher />
          ) : (
            <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-default)] bg-white/60 px-3 py-3 text-center">
              <p className="text-sm font-medium text-[var(--color-text-primary)]">还没有账号</p>
              <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1">添加账号后开始收发邮件</p>
              <button
                onClick={() => store.openAccountForm()}
                className="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-button)] border border-[var(--color-accent)] text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-bg-accent-10)] transition-smooth focus-ring"
              >
                <UserPlus size={14} />
                添加账号
              </button>
            </div>
          )}
        </div>
      )}
      {collapsed && !hasAccounts && (
        <div className="px-3 pb-2 flex justify-center">
          <button
            onClick={() => store.openAccountForm()}
            className="w-9 h-9 rounded-full border border-dashed border-[var(--color-border-default)] flex items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] transition-smooth"
            title="添加账号"
          >
            <UserPlus size={16} />
          </button>
        </div>
      )}
      {collapsed && currentAccount && (
        <div className="px-3 pb-2 flex justify-center">
          <button
            onClick={() => {
              const otherAccount = store.accounts.find(a => a.id !== store.currentAccountId);
              if (otherAccount) store.setCurrentAccount(otherAccount.id);
            }}
            className="w-9 h-9 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-xs font-bold transition-smooth hover:scale-105"
            style={{
              backgroundImage: `linear-gradient(135deg, ${currentAccount.avatarColors[0]}, ${currentAccount.avatarColors[1]})`,
            }}
            title={`${currentAccount.name} (${currentAccount.email})`}
          >
            {getInitials(currentAccount.name)}
          </button>
        </div>
      )}

      {/* Folder list */}
      <nav className="flex-1 overflow-y-auto px-2 py-1">
        {mainFolders.map(folder => (
          <FolderItem
            key={folder.id}
            folder={folder}
            isActive={store.currentFolderId === folder.id}
            collapsed={collapsed}
            onClick={() => store.setCurrentFolder(folder.id)}
          />
        ))}

        {customFolders.length > 0 && (
          <>
            {!collapsed && (
              <div className="px-3 pt-4 pb-1 text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">
                文件夹
              </div>
            )}
            {collapsed && <div className="my-2 mx-3 border-t border-[var(--color-border-default)]" />}
            {customFolders.map(folder => (
              <FolderItem
                key={folder.id}
                folder={folder}
                isActive={store.currentFolderId === folder.id}
                collapsed={collapsed}
                onClick={() => store.setCurrentFolder(folder.id)}
              />
            ))}
          </>
        )}
      </nav>

      {/* Settings */}
      <div className="px-2 py-3 border-t border-[var(--color-border-default)]">
        <button
          onClick={() => store.openSettings()}
          className={`flex items-center gap-2 w-full rounded-[var(--radius-sm)] px-3 py-2 text-[var(--color-text-secondary)] transition-smooth hover:bg-[var(--color-bg-hover)] focus-ring ${
            collapsed ? 'justify-center' : ''
          }`}
          title="设置"
        >
          <Settings size={18} />
          {!collapsed && <span className="text-sm">设置</span>}
        </button>
      </div>
    </motion.aside>
  );
}

function FolderItem({ folder, isActive, collapsed, onClick }: {
  folder: { id: string; name: string; icon: string; unreadCount: number; color?: string };
  isActive: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 w-full rounded-[var(--radius-sm)] px-3 py-2 text-sm transition-smooth focus-ring ${
        collapsed ? 'justify-center' : ''
      } ${
        isActive
          ? 'bg-[var(--color-bg-selected)] text-[var(--color-accent)] font-medium'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
      }`}
      title={folder.name}
    >
      <span className={isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-tertiary)]'}>
        {iconMap[folder.icon] || <Inbox size={18} />}
      </span>
      {!collapsed && (
        <>
          <span className="flex-1 text-left truncate">{folder.name}</span>
          {folder.unreadCount > 0 && (
            <span className="min-w-[20px] h-5 px-1.5 rounded-[var(--radius-tag)] bg-[var(--color-accent)] text-white text-xs flex items-center justify-center font-medium">
              {folder.unreadCount}
            </span>
          )}
        </>
      )}
      {collapsed && folder.unreadCount > 0 && (
        <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[var(--color-accent)]" />
      )}
    </button>
  );
}

function AccountSwitcher() {
  const store = useMailStore();
  const currentAccount = store.accounts.find(a => a.id === store.currentAccountId);
  const [isOpen, setIsOpen] = useState(false);

  if (!currentAccount) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2.5 w-full rounded-[var(--radius-sm)] px-2 py-1.5 transition-smooth hover:bg-[var(--color-bg-hover)]"
      >
        <div
          className="w-7 h-7 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
          style={{
            backgroundImage: `linear-gradient(135deg, ${currentAccount.avatarColors[0]}, ${currentAccount.avatarColors[1]})`,
          }}
        >
          {getInitials(currentAccount.name)}
        </div>
        <div className="flex-1 text-left min-w-0">
          <div className="text-sm font-medium text-[var(--color-text-primary)] truncate">{currentAccount.name}</div>
          <div className="text-xs text-[var(--color-text-tertiary)] truncate">{currentAccount.email}</div>
        </div>
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} className="rotate-90" />}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-[var(--radius-card)] shadow-[var(--shadow-dropdown)] border border-[var(--color-border-default)] z-20 overflow-hidden">
            {store.accounts.map(account => (
              <button
                key={account.id}
                onClick={() => {
                  store.setCurrentAccount(account.id);
                  setIsOpen(false);
                }}
                className={`flex items-center gap-2.5 w-full px-3 py-2.5 text-sm transition-smooth hover:bg-[var(--color-bg-hover)] ${
                  account.id === currentAccount.id ? 'bg-[var(--color-bg-selected)]' : ''
                }`}
              >
                <div
                  className="w-7 h-7 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                  style={{
                    backgroundImage: `linear-gradient(135deg, ${account.avatarColors[0]}, ${account.avatarColors[1]})`,
                  }}
                >
                  {getInitials(account.name)}
                </div>
                <div className="text-left min-w-0">
                  <div className="font-medium text-[var(--color-text-primary)] truncate">{account.name}</div>
                  <div className="text-xs text-[var(--color-text-tertiary)] truncate">{account.email}</div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
