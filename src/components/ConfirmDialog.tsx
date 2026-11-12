import { useEffect, useId, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';

export interface ConfirmDialogInput {
  label?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: string;
  okText?: string;
  cancelText?: string;
  pendingText?: string;
  danger?: boolean;
  pending?: boolean;
  error?: string | null;
  input?: ConfirmDialogInput;
  onConfirm: () => void;
  onCancel: () => void;
}

interface DialogView {
  title: string;
  message?: string;
  okText?: string;
  cancelText?: string;
  pendingText?: string;
  danger?: boolean;
  pending?: boolean;
  error?: string | null;
  input?: ConfirmDialogInput;
}

/**
 * 受控确认/输入对话框。
 * 关闭时 AnimatePresence 仍会渲染一次离场动画，所以用 ref 记住最后一次打开时的文案，
 * 避免父组件把状态清空后对话框闪一下空白标题。
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const { open, onCancel } = props;
  const live: DialogView = {
    title: props.title,
    message: props.message,
    okText: props.okText,
    cancelText: props.cancelText,
    pendingText: props.pendingText,
    danger: props.danger,
    pending: props.pending,
    error: props.error,
    input: props.input,
  };
  const lastOpenView = useRef<DialogView>(live);
  if (open) lastOpenView.current = live;
  const view = open ? live : lastOpenView.current;

  const titleId = useId();
  const descriptionId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // 关闭后把焦点还给打开对话框的元素（若它仍在文档中）。
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target && document.contains(target)) target.focus();
    };
  }, [open]);

  // 危险操作的默认焦点放在“取消”上，避免连按回车误删。
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      if (view.input) inputRef.current?.focus();
      else if (view.danger) cancelRef.current?.focus();
      else confirmRef.current?.focus();
    }, 20);
    return () => window.clearTimeout(timer);
  }, [open, Boolean(view.input), Boolean(view.danger)]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!view.pending) onCancel();
      return;
    }

    if (event.key === 'Enter') {
      // 焦点在按钮上时让按钮自己处理回车（取消键聚焦时按回车只取消）。
      if ((event.target as HTMLElement).closest('button')) return;
      event.preventDefault();
      event.stopPropagation();
      if (!view.pending) props.onConfirm();
      return;
    }

    // 对话框内 Tab 循环，焦点不跑回被遮住的页面。
    if (event.key === 'Tab') {
      const focusable = cardRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[300] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onKeyDown={event => {
            // 全局快捷键监听在 window 上：确认框内未处理的按键在冒泡阶段截住。
            if (!event.defaultPrevented) event.stopPropagation();
          }}
        >
          <div
            className="dialog-overlay absolute inset-0"
            onClick={() => {
              if (!view.pending) onCancel();
            }}
          />
          <motion.div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={view.message ? descriptionId : undefined}
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.25, 1] }}
            onKeyDown={handleKeyDown}
            className="dialog-card relative w-full max-w-[420px] px-6 pt-6 pb-5"
          >
            <h2 id={titleId} className="text-[17px] leading-6 font-semibold text-[var(--color-text-primary)]">
              {view.title}
            </h2>

            {view.message && (
              <p
                id={descriptionId}
                className="mt-2 whitespace-pre-wrap text-[14px] leading-6 text-[var(--color-text-secondary)]"
              >
                {view.message}
              </p>
            )}

            {view.input && (
              <label className="mt-4 block">
                {view.input.label && (
                  <span className="mb-1.5 block text-[13px] text-[var(--color-text-tertiary)]">
                    {view.input.label}
                  </span>
                )}
                <input
                  ref={inputRef}
                  type="text"
                  value={view.input.value}
                  onChange={event => view.input?.onChange(event.target.value)}
                  placeholder={view.input.placeholder}
                  className="input"
                  disabled={view.pending}
                />
              </label>
            )}

            {view.error && <div className="notice notice-error mt-3">{view.error}</div>}

            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                ref={cancelRef}
                type="button"
                className="btn btn-secondary"
                onClick={onCancel}
                disabled={view.pending}
              >
                {view.cancelText ?? '取消'}
              </button>
              <button
                ref={confirmRef}
                type="button"
                className={`btn ${view.danger ? 'btn-danger' : 'btn-primary'}`}
                onClick={props.onConfirm}
                disabled={view.pending}
              >
                {view.pending ? (view.pendingText ?? '处理中…') : (view.okText ?? '确定')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
