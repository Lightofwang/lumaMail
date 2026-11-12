import { useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { useMailStore } from '@/store/mailStore';
import type { Toast } from '@/types';

const toneMap = {
  success: 'bg-white border-[rgba(0,0,0,0.06)] text-[var(--color-text-primary)] shadow-[var(--shadow-pop)]',
  info: 'bg-white border-[rgba(0,0,0,0.06)] text-[var(--color-text-primary)] shadow-[var(--shadow-pop)]',
  warning: 'bg-[var(--color-notice-bg)] border-[rgba(169,97,10,0.12)] text-[var(--color-warning)]',
  error: 'bg-[var(--color-danger-soft)] border-[rgba(255,56,73,0.16)] text-[var(--color-danger)]',
};

export function ToastContainer() {
  const store = useMailStore();

  return (
    <div className="pointer-events-none fixed top-4 left-1/2 z-[400] flex w-[min(420px,calc(100vw-32px))] -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence>
        {store.toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const store = useMailStore();

  // 视觉规范要求约 2.4 秒消失；store 的兜底定时器仍是 3 秒，这里按界面口径提前收起。
  useEffect(() => {
    const timer = window.setTimeout(() => store.removeToast(toast.id), 2400);
    return () => window.clearTimeout(timer);
  }, [toast.id]);

  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
      className={`pointer-events-auto flex max-w-full items-center gap-3 rounded-full border px-4 py-2 ${toneMap[toast.type]}`}
    >
      <span className="min-w-0 truncate text-[13px]">{toast.message}</span>
      <button
        onClick={() => store.removeToast(toast.id)}
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full opacity-60 transition-opacity hover:opacity-100"
        aria-label="关闭提示"
      >
        <X size={13} />
      </button>
    </motion.div>
  );
}
