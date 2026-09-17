// ============================================================
// Info Popup Component – v0.3.0 (Accessibility: Escape, click-outside, focus trap)
// ============================================================

import { useState, useRef, useEffect, useCallback } from 'react';
import styles from './InfoPopup.module.css';

interface InfoPopupProps {
  title: string;
  content: string;
  rules?: string[];
}

const FOCUSABLE_SELECTORS = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function InfoPopup({ title, content, rules = [] }: InfoPopupProps) {
  const [isOpen, setIsOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close popup helper
  const close = useCallback(() => {
    setIsOpen(false);
    // Return focus to trigger
    triggerRef.current?.focus();
  }, []);

  // Escape key closes popup
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, close]);

  // Click outside closes popup
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (isOpen && popupRef.current && !popupRef.current.contains(e.target as Node)) {
        close();
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, close]);

  // Focus trap (Tab cycles within popup)
  useEffect(() => {
    if (!isOpen || !popupRef.current) return;

    const popup = popupRef.current;
    const focusable = Array.from(popup.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
    if (focusable.length === 0) return;

    // Focus first element
    focusable[0].focus();

    function handleTabKey(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const focusableNow = Array.from(popup.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
      if (focusableNow.length === 0) return;

      const first = focusableNow[0];
      const last = focusableNow[focusableNow.length - 1];

      if (e.shiftKey) {
        // Shift+Tab: if on first, go to last
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab: if on last, go to first
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', handleTabKey);
    return () => document.removeEventListener('keydown', handleTabKey);
  }, [isOpen]);

  return (
    <div className={styles.wrapper} ref={popupRef}>
      <button
        ref={triggerRef}
        className={styles.trigger}
        onClick={() => setIsOpen(!isOpen)}
        aria-label={`Info zu ${title}`}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
      </button>

      {isOpen && (
        <div
          className={styles.popup}
          role="dialog"
          aria-labelledby="info-title"
          aria-modal="false"
        >
          <div className={styles.header}>
            <h4 id="info-title" className={styles.title}>{title}</h4>
            <button
              className={styles.close}
              onClick={close}
              aria-label="Schließen"
            >
              ×
            </button>
          </div>

          <p className={styles.content}>{content}</p>

          {rules.length > 0 && (
            <ul className={styles.rules}>
              {rules.map((rule, i) => (
                <li key={i}>{rule}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
