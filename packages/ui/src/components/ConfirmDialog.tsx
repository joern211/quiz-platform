// ============================================================
// ConfirmDialog – Bestätigung für tatsächlich destruktive Aktionen
// (z. B. Spiel vorzeitig beenden). Fokus startet auf „Abbrechen“,
// damit Enter nie versehentlich bestätigt. Escape = Abbrechen.
// ============================================================

import { useRef, type ReactNode } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** rot + Warnsymbol für kritische Aktionen */
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = 'Abbrechen', danger = false, pending = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      isOpen={open}
      onClose={() => { if (!pending) onCancel(); }}
      title={title}
      size="sm"
      alert
      initialFocusRef={cancelRef as React.RefObject<HTMLElement>}
      footer={(
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={pending}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={pending}>
            {danger && <span aria-hidden="true">⚠</span>} {confirmLabel}
          </Button>
        </>
      )}
    >
      {children}
    </Modal>
  );
}
