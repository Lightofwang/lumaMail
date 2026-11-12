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
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ToastContainer } from '@/components/Toast';
import { SkeletonLoader } from '@/components/SkeletonLoader';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import { X } from 'lucide-react';

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

  // On first mount at a narrow width, keep the list usable by collapsing the sidebar.
  // 自动折叠只改内存状态，不写 localStorage；只有用户手动折叠才持久化。
  useEffect(() => {
    const state = useMailStore.getState();
    if (windowWidth < 900 && !state.sidebarCollapsed) {
      useMailStore.setState({ sidebarCollapsed: true });
    }
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

    // Only auto-collapse when crossing from >=900 to <900, and user hasn't manually toggled.
    // 这两处同样只改内存状态，避免把自动布局写入偏好。
    if (wasWide && isNarrow && !store.sidebarCollapsed && !userToggledRef.current) {
      useMailStore.setState({ sidebarCollapsed: true });
    }
    // Auto-expand when crossing from <900 to >=900
    else if (!wasWide && isWide && store.sidebarCollapsed && !userToggledRef.current) {
      useMailStore.setState({ sidebarCollapsed: false });
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
    return (
      <MotionConfig reducedMotion="user">
        <SkeletonLoader />
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-full w-full overflow-hidden bg-[var(--color-ground)] text-[var(--color-text-primary)]">
        {/* Sidebar — 与页面底色同色，不加边框 */}
        <Sidebar onManualToggle={handleManualToggle} />

        {/* 主卡片：列表 + 阅读区共用一圈极淡描边 */}
        <main className="m-2 ml-0 flex min-w-0 flex-1 overflow-hidden rounded-[12px] border border-[rgba(0,0,0,0.05)] bg-white">
          <div className="mail-list-pane">
            <MailList />
          </div>

          {!isNarrow && <ReadingPanel />}
        </main>

        {/* 窄屏阅读浮层：白卡 + 纯黑遮罩，不套大阴影 */}
        <AnimatePresence>
          {isNarrow && showReadingOverlay && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
                className="fixed inset-0 z-30 bg-[rgba(0,0,0,0.32)]"
                onClick={() => store.selectThread(null)}
              />
              <motion.div
                initial={{ opacity: 0, x: 6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 6 }}
                transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                className="reading-overlay fixed top-2 right-2 bottom-2 z-40 flex flex-col overflow-hidden rounded-[12px] border border-[rgba(0,0,0,0.05)] bg-white"
              >
                <div className="flex h-[52px] flex-shrink-0 items-center justify-end border-b border-[var(--color-border-default)] px-3">
                  <button
                    onClick={() => store.selectThread(null)}
                    className="icon-btn"
                    aria-label="关闭阅读"
                    title="关闭阅读"
                  >
                    <X size={18} />
                  </button>
                </div>
                <ReadingPanel />
              </motion.div>
            </>
          )}
        </AnimatePresence>

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

        {/* 应用内确认框：所有删除/清空操作都走这里 */}
        <ConfirmDialog
          open={!!store.confirmRequest}
          title={store.confirmRequest?.title ?? ''}
          message={store.confirmRequest?.message}
          okText={store.confirmRequest?.okText}
          cancelText={store.confirmRequest?.cancelText}
          pendingText={store.confirmRequest?.pendingText}
          danger={store.confirmRequest?.danger}
          pending={store.confirmPending}
          error={store.confirmError}
          onConfirm={() => void store.submitConfirm()}
          onCancel={store.cancelConfirm}
        />

        {/* Toast container */}
        <ToastContainer />
      </div>
    </MotionConfig>
  );
}
