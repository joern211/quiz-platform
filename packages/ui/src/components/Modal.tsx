// ============================================================
// Modal Component – v0.3.0 (Accessibility: aria-modal, aria-labelledby, focus trap)
// ============================================================

import { ReactNode, useEffect, useRef, useCallback } from 'react';
import styles from './Modal.module.css';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const FOCUSABLE_SELECTORS = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({ isOpen, onClose, title, children, size = 'md' }: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = title ? 'modal-title' : undefined;

  // Close + return focus
  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // Escape key closes modal
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    }
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen, handleClose]);

  // Focus trap + focus first element on open
  useEffect(() => {
    if (!isOpen || !modalRef.current) return;

    const modal = modalRef.current;
    const focusable = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      // If nothing is focusable, focus the modal itself
      modal.setAttribute('tabindex', '-1');
      modal.focus();
    }

    function handleTabKey(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const focusableNow = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
      if (focusableNow.length === 0) return;

      const first = focusableNow[0];
      const last = focusableNow[focusableNow.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', handleTabKey);
    return () => document.removeEventListener('keydown', handleTabKey);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className={styles.overlay}
      onClick={handleClose}
      aria-hidden="true"
    >
      <div
        ref={modalRef}
        className={`${styles.modal} ${styles[size]}`}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {title && (
          <div className={styles.header}>
            <h2 id={titleId} className={styles.title}>{title}</h2>
            <button className={styles.close} onClick={handleClose} aria-label="Schließen">×</button>
          </div>
        )}
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
