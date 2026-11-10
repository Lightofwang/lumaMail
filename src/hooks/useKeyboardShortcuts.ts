import { useEffect, useCallback } from 'react';
import { useMailStore } from '@/store/mailStore';

export function useKeyboardShortcuts() {
  const store = useMailStore();

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Skip shortcuts when input is focused
    const target = e.target as HTMLElement;
    const isInputFocused = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

    // Global shortcuts (always work)
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if (store.isCommandPaletteOpen) {
        store.closeCommandPalette();
      } else {
        store.openCommandPalette();
      }
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
      e.preventDefault();
      store.openCompose();
      return;
    }

    if (e.key === 'Escape') {
      // Don't close modals if the search input is focused (it has its own Esc handler)
      const target = e.target as HTMLElement;
      const isSearchInput = target.hasAttribute('data-search-input');
      
      if (!isSearchInput) {
        if (store.isCommandPaletteOpen) {
          store.closeCommandPalette();
          return;
        }
        if (store.isComposing) {
          store.closeCompose();
          return;
        }
        if (store.isSettingsOpen) {
          store.closeSettings();
          return;
        }
        if (store.isAccountFormOpen) {
          store.closeAccountForm();
          return;
        }
        if (store.selectedThreadId) {
          store.selectThread(null);
          return;
        }
      }
    }

    // Skip single-key shortcuts when input is focused
    if (isInputFocused) return;

    const threads = store.getFilteredThreads();
    const currentIndex = threads.findIndex(t => t.id === store.selectedThreadId);

    switch (e.key) {
      case 'j': // Next thread
        e.preventDefault();
        if (currentIndex < threads.length - 1) {
          store.selectThread(threads[currentIndex + 1].id);
        } else if (threads.length > 0 && currentIndex === -1) {
          store.selectThread(threads[0].id);
        }
        break;

      case 'k': // Previous thread
        e.preventDefault();
        if (currentIndex > 0) {
          store.selectThread(threads[currentIndex - 1].id);
        }
        break;

      case 'Enter': // Open selected thread (already open on select)
        break;

      case 'c': // Compose
        e.preventDefault();
        store.openCompose();
        break;

      case 'r': // Reply
        if (store.selectedThreadId) {
          e.preventDefault();
          // Open compose with reply context
          const thread = store.getThreadById(store.selectedThreadId);
          if (thread) {
            store.openCompose({
              to: [thread.lastMessage.from],
              subject: thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`,
            });
          }
        }
        break;

      case 'e': // Archive
        if (store.selectedThreadId) {
          e.preventDefault();
          store.archiveThread(store.selectedThreadId);
        }
        break;

      case 's': // Star
        if (store.selectedThreadId) {
          e.preventDefault();
          store.toggleStarThread(store.selectedThreadId);
        }
        break;

      case '/': // Focus search
        e.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>('[data-search-input]');
        searchInput?.focus();
        break;
    }
  }, [store]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
