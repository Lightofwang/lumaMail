import { useState } from 'react';
import { motion } from 'motion/react';
import {
  Inbox, Star, Send, FileText, Archive, Trash2, Briefcase, User,
  Settings, ChevronDown, ChevronRight, PenSquare, Mail, Menu, UserPlus,
  ShieldAlert, Folder as FolderIcon, Check,
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
      animate={{ width: collapsed ? 64 : 240 }}
      transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
      className="flex h-full flex-shrink-0 flex-col overflow-hidden px-2"
    >
      {/* Brand：Logo 固定 28px，收起时只保留展开按钮 */}
      <div className="flex h-14 flex-shrink-0 items-center gap-2.5 px-1">
        <button
          onClick={handleToggle}
          className="icon-btn"
          title={collapsed ? '展开侧栏' : '折叠侧栏'}
          aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
        >
          <Menu size={18} />
        </button>
        {!collapsed && (
          <>
            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px] bg-[var(--color-accent)]">
              <Mail size={15} className="text-white" strokeWidth={1.7} />
            </div>
            <span className="whitespace-nowrap text-[16px] font-semibold text-[var(--color-text-primary)]">
              Luma Mail
            </span>
          </>
        )}
      </div>

      {/* Compose button */}
      <div className={collapsed ? 'flex justify-center py-2' : 'py-2'}>
        <button
          onClick={() => store.openCompose()}
          className={`btn btn-primary ${collapsed ? 'h-10 w-10 px-0' : 'h-10 w-full'}`}
          title="撰写邮件 (c)"
        >
          <PenSquare size={18} />
          {!collapsed && <span>撰写</span>}
        </button>
      </div>

      {/* Account switcher / empty-state guidance */}
      {!collapsed && (
        <div className="pb-2">
          {hasAccounts ? (
            <AccountSwitcher />
          ) : (
            <div className="group-card px-3 py-3">
              <p className="text-[13px] font-medium text-[var(--color-text-secondary)]">还没有账号</p>
              <p className="mt-1 text-[12px] text-[var(--color-text-tertiary)]">添加账号后开始收发邮件</p>
              <button
                onClick={() => store.openAccountForm()}
                className="btn btn-secondary mt-2.5 h-8 w-full text-[13px]"
              >
                <UserPlus size={14} />
                添加账号
              </button>
            </div>
          )}
        </div>
      )}
      {collapsed && !hasAccounts && (
        <div className="flex justify-center pb-2">
          <button
            onClick={() => store.openAccountForm()}
            className="icon-btn h-9 w-9"
            title="添加账号"
            aria-label="添加账号"
          >
            <UserPlus size={16} />
          </button>
        </div>
      )}
      {collapsed && currentAccount && (
        <div className="flex justify-center pb-2">
          <button
            onClick={() => {
              const otherAccount = store.accounts.find(a => a.id !== store.currentAccountId);
              if (otherAccount) store.setCurrentAccount(otherAccount.id);
            }}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-fill)] text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-fill-hover)]"
            title={`${currentAccount.name} (${currentAccount.email})`}
          >
            {getInitials(currentAccount.name)}
          </button>
        </div>
      )}

      {/* Folder list */}
      <nav className="flex-1 overflow-y-auto py-1">
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
            {!collapsed && <div className="section-caption px-2.5 pt-4 pb-1">文件夹</div>}
            {collapsed && <div className="mx-2 my-2 h-px bg-[var(--color-border-default)]" />}
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
      <div className="py-2">
        <button
          onClick={() => store.openSettings()}
          className={`flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-[14px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] ${
            collapsed ? 'justify-center px-0' : ''
          }`}
          title="设置"
        >
          <Settings size={18} />
          {!collapsed && <span>设置</span>}
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
      className={`relative flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-[14px] transition-colors ${
        collapsed ? 'justify-center px-0' : ''
      } ${
        isActive
          ? 'bg-[var(--color-bg-selected)] font-medium text-[var(--color-text-primary)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]'
      }`}
      title={folder.name}
    >
      <span className={isActive ? 'text-[var(--color-text-primary)]' : 'text-[rgba(0,0,0,0.55)]'}>
        {iconMap[folder.icon] || <Inbox size={18} />}
      </span>
      {!collapsed && (
        <>
          <span className="flex-1 truncate text-left">{folder.name}</span>
          {folder.unreadCount > 0 && (
            <span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
              {folder.unreadCount}
            </span>
          )}
        </>
      )}
      {collapsed && folder.unreadCount > 0 && (
        <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[rgba(0,0,0,0.06)] px-1 text-[10px] tabular-nums text-[var(--color-text-secondary)]">
          {folder.unreadCount}
        </span>
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
        className="flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 transition-colors hover:bg-[var(--color-bg-hover)]"
      >
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-fill)] text-[11px] font-medium text-[var(--color-text-secondary)]">
          {getInitials(currentAccount.name)}
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="truncate text-[13px] text-[var(--color-text-primary)]">{currentAccount.name}</div>
          <div className="truncate text-[12px] text-[var(--color-text-tertiary)]">{currentAccount.email}</div>
        </div>
        {isOpen ? (
          <ChevronDown size={14} className="flex-shrink-0 text-[var(--color-text-tertiary)]" />
        ) : (
          <ChevronRight size={14} className="flex-shrink-0 text-[var(--color-text-tertiary)]" />
        )}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="menu-panel absolute top-full left-0 right-0 z-20 mt-1">
            {store.accounts.map(account => (
              <button
                key={account.id}
                onClick={() => {
                  store.setCurrentAccount(account.id);
                  setIsOpen(false);
                }}
                className={`flex h-10 w-full items-center gap-2 rounded-[8px] px-2 text-left text-[14px] transition-colors hover:bg-[var(--color-bg-hover)] ${
                  account.id === currentAccount.id ? 'bg-[var(--color-bg-selected)]' : ''
                }`}
              >
                <span className="flex w-4 flex-shrink-0 justify-center text-[var(--color-text-primary)]">
                  {account.id === currentAccount.id && <Check size={14} />}
                </span>
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-fill)] text-[11px] font-medium text-[var(--color-text-secondary)]">
                  {getInitials(account.name)}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-[var(--color-text-primary)]">{account.name}</div>
                  <div className="truncate text-[11px] text-[var(--color-text-tertiary)]">{account.email}</div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
