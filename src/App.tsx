import { useEffect, useRef } from 'react';
import { useMailStore } from '@/store/mailStore';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useWindowWidth } from '@/hooks/useWindowWidth';
import { Sidebar } from '@/components/Sidebar';
import { MailList } from '@/components/MailList';
import { ReadingPanel } from '@/components/ReadingPanel';
import { ComposeModal } from '@/components/ComposeModal';
import { CommandPalette } from '@/components/CommandPalette';
import { SettingsPanel } from '@/components/SettingsPanel';
import { AccountSetupModal } from '@/components/AccountSetupModal';
import { ToastContainer } from '@/components/Toast';
import { SkeletonLoader } from '@/components/SkeletonLoader';
import { motion, AnimatePresence } from 'motion/react';
import { X, Menu } from 'lucide-react';

export function App() {
  const store = useMailStore();
  const windowWidth = useWindowWidth();
  const prevWidthRef = useRef(windowWidth);
  const userToggledRef = useRef(false);

  // Register keyboard shortcuts
  useKeyboardShortcuts();

  // Load saved accounts and folders from the Rust backend
  useEffect(() => {
    void useMailStore.getState().bootstrap();
  }, []);

  // Responsive: auto-collapse/expand sidebar on width threshold crossing
  useEffect(() => {
    const prevWidth = prevWidthRef.current;
    const wasWide = prevWidth >= 900;
    const isNarrow = windowWidth < 900;
    const isWide = windowWidth >= 900;

    // Reset user toggle flag when width goes back to wide
    if (isWide) {
      userToggledRef.current = false;
    }

    // Only auto-collapse when crossing from >=900 to <900, and user hasn't manually toggled
    if (wasWide && isNarrow && !store.sidebarCollapsed && !userToggledRef.current) {
      store.toggleSidebar();
    }
    // Auto-expand when crossing from <900 to >=900
    else if (!wasWide && isWide && store.sidebarCollapsed && !userToggledRef.current) {
      store.toggleSidebar();
    }

    prevWidthRef.current = windowWidth;
  }, [windowWidth]);

  // Track user manual toggle to prevent effect from overriding
  const handleManualToggle = () => {
    userToggledRef.current = true;
    store.toggleSidebar();
  };

  // Apply font size as CSS variable
  useEffect(() => {
    document.documentElement.style.setProperty('--font-size-body', `${store.settings.fontSize}px`);
  }, [store.settings.fontSize]);

  // Responsive: reading panel as overlay on narrow screens
  const isNarrow = windowWidth < 1100;
  const showReadingOverlay = isNarrow && store.selectedThreadId;

  if (!store.isInitialized) {
    return <SkeletonLoader />;
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-white">
      {/* Sidebar */}
      <Sidebar onManualToggle={handleManualToggle} />

      {/* Mail list */}
      <div className="w-[360px] flex-shrink-0 h-full overflow-hidden">
        <MailList />
      </div>

      {/* Reading panel */}
      {isNarrow ? (
        <AnimatePresence>
          {showReadingOverlay && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/20 z-30"
                onClick={() => store.selectThread(null)}
              />
              <motion.div
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                className="fixed top-0 right-0 bottom-0 w-full max-w-[680px] z-40 bg-white shadow-[var(--shadow-dropdown)]"
              >
                <div className="flex items-center justify-end p-2">
                  <button
                    onClick={() => store.selectThread(null)}
                    className="p-2 rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-hover)] transition-smooth"
                  >
                    <X size={18} />
                  </button>
                </div>
                <ReadingPanel />
              </motion.div>
            </>
          )}
        </AnimatePresence>
      ) : (
        <ReadingPanel />
      )}

      {/* Compose modal */}
      {store.isComposing && (
        <ComposeModal initialData={store.composeDraft} />
      )}

      {/* Command palette */}
      <CommandPalette />

      {/* Settings panel */}
      <SettingsPanel />

      {/* Account setup */}
      <AccountSetupModal />

      {/* Toast container */}
      <ToastContainer />
    </div>
  );
}
