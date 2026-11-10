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
            className="fixed inset-0 bg-black/20 z-50"
            onClick={() => store.closeCommandPalette()}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -8 }}
            transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
            className="fixed top-[20%] left-1/2 -translate-x-1/2 w-[520px] max-h-[420px] bg-white rounded-[var(--radius-card)] shadow-[var(--shadow-dropdown)] border border-[var(--color-border-default)] z-50 overflow-hidden flex flex-col"
            onKeyDown={handleKeyDown}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border-default)]">
              <Search size={18} className="text-[var(--color-text-tertiary)] flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="输入命令或搜索..."
                className="flex-1 text-sm outline-none placeholder:text-[var(--color-text-tertiary)]"
              />
              <kbd className="px-1.5 py-0.5 rounded text-xs bg-[var(--color-bg-sidebar)] text-[var(--color-text-tertiary)] border border-[var(--color-border-default)]">
                Esc
              </kbd>
            </div>

            {store.accounts.length === 0 && (
              <div className="px-4 py-2 text-xs text-[var(--color-text-tertiary)] border-b border-[var(--color-border-default)] bg-[var(--color-bg-sidebar)]">
                还没有账号，添加账号后可导航邮件。
              </div>
            )}

            {/* Results */}
            <div className="flex-1 overflow-y-auto py-2">
              {filteredCommands.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-[var(--color-text-tertiary)]">
                  未找到匹配的命令
                </div>
              ) : (
                Object.entries(groupedCommands).map(([category, cmds]) => (
                  <div key={category}>
                    <div className="px-4 py-1.5 text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">
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
                          className={`flex items-center gap-3 w-full px-4 py-2 text-sm transition-smooth ${
                            isSelected ? 'bg-[var(--color-bg-selected)]' : 'hover:bg-[var(--color-bg-hover)]'
                          }`}
                        >
                          <span className={isSelected ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-tertiary)]'}>
                            {cmd.icon}
                          </span>
                          <span className="flex-1 text-left text-[var(--color-text-primary)]">{cmd.label}</span>
                          {cmd.description && (
                            <span className="text-xs text-[var(--color-text-tertiary)]">{cmd.description}</span>
                          )}
                          {cmd.shortcut && (
                            <kbd className="px-1.5 py-0.5 rounded text-xs bg-[var(--color-bg-sidebar)] text-[var(--color-text-tertiary)] border border-[var(--color-border-default)]">
                              {cmd.shortcut}
                            </kbd>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--color-border-default)] bg-[var(--color-bg-sidebar)]">
              <div className="flex items-center gap-3 text-xs text-[var(--color-text-tertiary)]">
                <span><kbd className="px-1 py-0.5 rounded bg-white border border-[var(--color-border-default)]">↑↓</kbd> 选择</span>
                <span><kbd className="px-1 py-0.5 rounded bg-white border border-[var(--color-border-default)]">↵</kbd> 执行</span>
                <span><kbd className="px-1 py-0.5 rounded bg-white border border-[var(--color-border-default)]">esc</kbd> 关闭</span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
