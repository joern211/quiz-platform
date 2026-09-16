// ============================================================
// Info Popup Component
// ============================================================

import { useState, useRef, useEffect } from 'react';
import styles from './InfoPopup.module.css';

interface InfoPopupProps {
  title: string;
  content: string;
  rules?: string[];
}

export function InfoPopup({ title, content, rules = [] }: InfoPopupProps) {
  const [isOpen, setIsOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div className={styles.wrapper} ref={popupRef}>
      <button 
        className={styles.trigger}
        onClick={() => setIsOpen(!isOpen)}
        aria-label={`Info zu ${title}`}
        aria-expanded={isOpen}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
      </button>

      {isOpen && (
        <div className={styles.popup} role="dialog" aria-labelledby="info-title">
          <div className={styles.header}>
            <h4 id="info-title" className={styles.title}>{title}</h4>
            <button 
              className={styles.close}
              onClick={() => setIsOpen(false)}
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
