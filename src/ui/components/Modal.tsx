import { useEffect, useRef, type ReactNode } from 'react';
import { Button, type ButtonVariant } from './Button.tsx';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  title: string;
  titleAddon?: ReactNode;
  onClose: () => void;
  /** Blocks Escape/backdrop/close-button dismissal while an action runs. */
  busy?: boolean;
  showClose?: boolean;
  children: ReactNode;
}

/**
 * The one dialog implementation: focus trap, Escape, backdrop dismiss,
 * initial focus, and focus restoration to the opening control.
 */
export function Modal({ title, titleAddon, onClose, busy = false, showClose = true, children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initial = dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    initial?.focus();

    const handleKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeys);
    return () => {
      window.removeEventListener('keydown', handleKeys);
      returnFocus?.focus();
    };
  }, []);

  return (
    <div
      className="asf-modal-backdrop"
      onClick={() => {
        if (!busyRef.current) onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="asf-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="asf-modal__header">
          <h2>{title}</h2>
          {titleAddon}
          {showClose && (
            <button
              type="button"
              className="asf-modal__close"
              onClick={() => onCloseRef.current()}
              disabled={busy}
              aria-label="Close dialog"
            >
              X
            </button>
          )}
        </header>
        {children}
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  title: string;
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  children: ReactNode;
}

/** Replacement for window.confirm on destructive or costly actions. */
export function ConfirmDialog({
  title,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  onConfirm,
  onCancel,
  busy = false,
  children,
}: ConfirmDialogProps) {
  return (
    <Modal title={title} onClose={onCancel} busy={busy} showClose={false}>
      <div className="asf-modal__copy">{children}</div>
      <div className="asf-modal__actions">
        <Button onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button variant={confirmVariant} onClick={onConfirm} disabled={busy}>
          {busy ? 'Working...' : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
