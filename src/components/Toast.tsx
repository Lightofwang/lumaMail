import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useMailStore } from '@/store/mailStore';

const iconMap = {
  success: <CheckCircle size={16} className="text-[var(--color-success)]" />,
  error: <XCircle size={16} className="text-[var(--color-error)]" />,
  info: <Info size={16} className="text-[var(--color-info)]" />,
  warning: <AlertTriangle size={16} className="text-[var(--color-warning)]" />,
};

const bgMap = {
  success: 'bg-[var(--color-success)]/10 border-[var(--color-success)]/20',
  error: 'bg-[var(--color-error)]/10 border-[var(--color-error)]/20',
  info: 'bg-[var(--color-info)]/10 border-[var(--color-info)]/20',
  warning: 'bg-[var(--color-warning)]/10 border-[var(--color-warning)]/20',
};

export function ToastContainer() {
  const store = useMailStore();

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 items-center pointer-events-none">
      <AnimatePresence>
        {store.toasts.map(toast => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-[var(--radius-button)] border shadow-[var(--shadow-card)] pointer-events-auto ${bgMap[toast.type]}`}
          >
            {iconMap[toast.type]}
            <span className="text-sm font-medium text-[var(--color-text-primary)]">{toast.message}</span>
            <button
              onClick={() => store.removeToast(toast.id)}
              className="ml-2 p-0.5 rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-smooth"
            >
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
