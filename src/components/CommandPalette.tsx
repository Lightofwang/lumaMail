import { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Inbox, Star, Send, FileText, Archive, Trash2, PenSquare, Settings, User, Hash, UserPlus, ShieldAlert } from 'lucide-react';
import { useMailStore } from '@/store/mailStore';

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  category: 'navigation' | 'action' | 'settings';
  shortcut?: string;
  action: () => void;
}

export function CommandPalette() {
  const store = useMailStore();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands: CommandItem[] = useMemo(() => {
    const items: CommandItem[] = [];

    // Navigation — built from the current account's folders (none when empty)
    const accountFolders = store.folders.filter(f => f.accountId === store.currentAccountId);
    const navOrder: Array<{ type: string; icon: React.ReactNode }> = [
      { type: 'inbox', icon: <Inbox size={16} /> },
      { type: 'starred', icon: <Star size={16} /> },
      { type: 'sent', icon: <Send size={16} /> },
      { type: 'drafts', icon: <FileText size={16} /> },
      { type: 'junk', icon: <ShieldAlert size={16} /> },
      { type: 'archive', icon: <Archive size={16} /> },
      { type: 'trash', icon: <Trash2 size={16} /> },
    ];
    for (const { type, icon } of navOrder) {
      const folder = accountFolders.find(f => f.type === type);
      if (!folder) continue;
      items.push({
        id: `nav-${folder.id}`,
        label: `打开${folder.name}`,
        description: folder.unreadCount > 0 ? `${folder.unreadCount} 封未读` : undefined,
        icon,
        category: 'navigation',
        action: () => { store.setCurrentFolder(folder.id); store.closeCommandPalette(); },
      });
    }

    // Actions
    items.push({
      id: 'act-compose',
      label: store.accounts.length === 0 ? '添加账号以开始撰写' : '撰写新邮件',
      description: store.accounts.length === 0 ? '还没有账号' : '创建一封新邮件',
      icon: <PenSquare size={16} />,
      category: 'action',
      shortcut: 'c',
      action: () => {
        if (store.accounts.length === 0) {
          store.openAccountForm();
        } else {
          store.openCompose();
          store.closeCommandPalette();
        }
      },
    });

    for (const account of store.accounts) {
      items.push({
        id: `act-switch-${account.id}`,
        label: `切换到账号：${account.name || account.email}`,
        description: account.email,
        icon: <User size={16} />,
        category: 'action',
        action: () => { store.setCurrentAccount(account.id); store.closeCommandPalette(); },
      });
    }

    items.push({
      id: 'act-add-account',
      label: '添加账号',
      description: '通过 IMAP / SMTP 添加邮箱',
      icon: <UserPlus size={16} />,
      category: 'action',
      action: () => { store.openAccountForm(); },
    });

    // Settings
    items.push(
      {
        id: 'set-open', label: '打开设置', description: '应用设置',
        icon: <Settings size={16} />, category: 'settings',
        action: () => { store.openSettings(); store.closeCommandPalette(); },
      },
      {
        id: 'set-density-comfortable', label: '切换密度：舒适', description: '列表行高 56px',
        icon: <Hash size={16} />, category: 'settings',
        action: () => { store.setDensity('comfortable'); store.closeCommandPalette(); },
      },
      {
        id: 'set-density-compact', label: '切换密度：紧凑', description: '列表行高 44px',
        icon: <Hash size={16} />, category: 'settings',
        action: () => { store.setDensity('compact'); store.closeCommandPalette(); },
      },
    );

    return items;
  }, [store]);

  const filteredCommands = useMemo(() => {
    if (!query) return commands;
    const q = query.toLowerCase();
    return commands.filter(c =>
      c.label.toLowerCase().includes(q) ||
      c.description?.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q)
    );
  }, [commands, query]);

  const categoryLabels: Record<string, string> = {
    navigation: '导航',
    action: '操作',
    settings: '设置',
  };

  const groupedCommands = useMemo(() => {
    const groups: Record<string, CommandItem[]> = {};
    for (const cmd of filteredCommands) {
      if (!groups[cmd.category]) groups[cmd.category] = [];
      groups[cmd.category].push(cmd);
    }
    return groups;
  }, [filteredCommands]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (store.isCommandPaletteOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [store.isCommandPaletteOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const flatCommands = filteredCommands;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, flatCommands.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (flatCommands[selectedIndex]) {
          flatCommands[selectedIndex].action();
        }
        break;
      case 'Escape':
        e.preventDefault();
        store.closeCommandPalette();
        break;
    }
  };

  let flatIndex = 0;

  return (
    <AnimatePresence>
      {store.isCommandPaletteOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="dialog-overlay fixed inset-0 z-50"
            onClick={() => store.closeCommandPalette()}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -6 }}
            transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
            className="palette-card fixed top-[20%] left-1/2 z-50 flex max-h-[420px] -translate-x-1/2 flex-col overflow-hidden rounded-[16px] border border-[rgba(0,0,0,0.05)] bg-white shadow-[var(--shadow-pop)]"
            onKeyDown={handleKeyDown}
            role="dialog"
            aria-modal="true"
            aria-label="命令面板"
          >
            {/* Search input */}
            <div className="flex items-center gap-3 border-b border-[rgba(0,0,0,0.06)] px-4 py-3">
              <Search size={18} className="flex-shrink-0 text-[var(--color-text-tertiary)]" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="输入命令或搜索…"
                className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--color-text-tertiary)]"
              />
              <kbd className="kbd">Esc</kbd>
            </div>

            {store.accounts.length === 0 && (
              <div className="border-b border-[rgba(0,0,0,0.06)] bg-[var(--color-admin-card)] px-4 py-2 text-[12px] text-[var(--color-text-tertiary)]">
                还没有账号，添加账号后可导航邮件。
              </div>
            )}

            {/* Results */}
            <div className="flex-1 overflow-y-auto p-2">
              {filteredCommands.length === 0 ? (
                <div className="px-4 py-10 text-center text-[13px] text-[var(--color-text-tertiary)]">
                  未找到匹配的命令
                </div>
              ) : (
                Object.entries(groupedCommands).map(([category, cmds]) => (
                  <div key={category}>
                    <div className="px-2 pb-1 pt-3 text-[12px] text-[var(--color-text-tertiary)]">
                      {categoryLabels[category]}
                    </div>
                    {cmds.map(cmd => {
                      const idx = flatIndex++;
                      const isSelected = idx === selectedIndex;
                      return (
                        <button
                          key={cmd.id}
                          onClick={cmd.action}
                          onMouseEnter={() => setSelectedIndex(idx)}
                          className={`flex h-10 w-full items-center gap-3 rounded-[10px] px-2.5 text-[14px] transition-[background-color,color] duration-150 ${
                            isSelected ? 'bg-[var(--color-bg-selected)]' : 'hover:bg-[var(--color-bg-hover)]'
                          }`}
                        >
                          <span className={isSelected ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)]'}>
                            {cmd.icon}
                          </span>
                          <span className="flex-1 truncate text-left text-[var(--color-text-primary)]">{cmd.label}</span>
                          {cmd.description && (
                            <span className="truncate text-[12px] text-[var(--color-text-tertiary)]">{cmd.description}</span>
                          )}
                          {cmd.shortcut && <kbd className="kbd">{cmd.shortcut}</kbd>}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-[rgba(0,0,0,0.06)] px-4 py-2">
              <div className="flex items-center gap-3 text-[12px] text-[var(--color-text-tertiary)]">
                <span className="flex items-center gap-1"><kbd className="kbd">↑↓</kbd> 选择</span>
                <span className="flex items-center gap-1"><kbd className="kbd">↵</kbd> 执行</span>
                <span className="flex items-center gap-1"><kbd className="kbd">esc</kbd> 关闭</span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
