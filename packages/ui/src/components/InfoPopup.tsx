// ============================================================
// Info Popup – nicht-modales Infofenster zu einem Trigger
// Wird per Portal am <body> gerendert und fest (position: fixed)
// an den Viewport geklemmt positioniert. Dadurch kann es von keinem
// Vorfahren mit overflow: hidden (z. B. Spielkarten) abgeschnitten
// werden. Escape/Schließen gibt den Fokus an den Trigger zurück.
// ============================================================

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './InfoPopup.module.css';

interface InfoPopupProps {
  title: string;
  content: string;
  rules?: string[];
}

const EDGE = 8; // Mindestabstand zum Viewportrand
const GAP = 8;  // Abstand zum Trigger

export function InfoPopup({ title, content, rules = [] }: InfoPopupProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const popupId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setIsOpen(false);
    setPosition(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const place = useCallback(() => {
    const trigger = triggerRef.current, popup = popupRef.current;
    if (!trigger || !popup) return;
    const rect = trigger.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const width = popup.offsetWidth, height = popup.offsetHeight;
    const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, EDGE), Math.max(EDGE, vw - width - EDGE));
    // bevorzugt oberhalb; sonst unterhalb; sonst so weit wie möglich im Viewport
    let top = rect.top - GAP - height;
    if (top < EDGE) top = rect.bottom + GAP;
    if (top + height > vh - EDGE) top = Math.max(EDGE, vh - EDGE - height);
    setPosition((old) => (old && old.top === top && old.left === left ? old : { top, left }));
  }, []);

  useLayoutEffect(() => {
    if (isOpen) place();
  }, [isOpen, place]);

  useEffect(() => {
    if (!isOpen) return;
    popupRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(true); } };
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('focusin', onFocus);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('focusin', onFocus);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [isOpen, close, place]);

  return (
    <div className={styles.wrapper}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => (isOpen ? close(false) : setIsOpen(true))}
        aria-label={`Info zu ${title}`}
        aria-expanded={isOpen}
        aria-controls={isOpen ? popupId : undefined}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
      </button>

      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={popupRef}
          id={popupId}
          className={styles.popup}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          // bis zur ersten Messung unsichtbar, damit es nicht an falscher Stelle aufblitzt
          style={position ? { top: position.top, left: position.left } : { visibility: 'hidden' }}
        >
          <div className={styles.header}>
            <h4 id={titleId} className={styles.title}>{title}</h4>
            <button type="button" className={styles.close} onClick={() => close(true)} aria-label="Schließen">
              <span aria-hidden="true">×</span>
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
        </div>,
        document.body,
      )}
    </div>
  );
}
