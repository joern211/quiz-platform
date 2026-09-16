// ============================================================
// Header Component – v0.2.1 (Accessible mobile nav)
// ============================================================

import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Logo, useTheme } from '@quiz/ui';
import styles from './Header.module.css';

export function Header() {
  const { theme, toggleTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && menuOpen) {
        setMenuOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [menuOpen]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // Trap focus inside menu when open
  useEffect(() => {
    if (menuOpen) {
      const links = menuRef.current?.querySelectorAll<HTMLAnchorElement>('a, button');
      links?.[0]?.focus();
    }
  }, [menuOpen]);

  return (
    <header className={styles.header}>
      <div className={styles.container}>
        {/* Logo */}
        <Link to="/" className={styles.logo} aria-label="Zur Startseite">
          <Logo />
          <span className={styles.logoText}>Online Quiz Plattform</span>
        </Link>

        {/* Desktop Nav */}
        <nav className={styles.nav} aria-label="Hauptnavigation">
          <Link to="/kategorien" className={styles.link}>Spiele</Link>
          <Link to="/raeume" className={styles.link}>Räume</Link>
          <Link to="/moderator/anmelden" className={styles.link}>Moderieren</Link>
          <Link to="/zuschauen" className={styles.link}>Zuschauen</Link>
        </nav>

        {/* Actions */}
        <div className={styles.actions}>
          <button
            onClick={toggleTheme}
            className={styles.themeToggle}
            aria-label={theme === 'dark' ? 'Zum hellen Theme wechseln' : 'Zum dunklen Theme wechseln'}
            title={theme === 'dark' ? 'Heller Modus' : 'Dunkler Modus'}
          >
            {theme === 'dark' ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="5" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>

          {/* Mobile menu toggle */}
          <button
            ref={toggleRef}
            className={styles.menuToggle}
            onClick={() => setMenuOpen(!menuOpen)}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label={menuOpen ? 'Menü schließen' : 'Menü öffnen'}
          >
            {menuOpen ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" width="24" height="24">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" width="24" height="24">
                <path d="M3 12h18M3 6h18M3 18h18" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {menuOpen && (
        <div
          id="mobile-menu"
          ref={menuRef}
          className={styles.mobileMenu}
          role="dialog"
          aria-label="Navigation"
        >
          <nav className={styles.mobileNav}>
            <Link to="/kategorien" className={styles.mobileLink} onClick={() => setMenuOpen(false)}>Spiele</Link>
            <Link to="/raeume" className={styles.mobileLink} onClick={() => setMenuOpen(false)}>Räume</Link>
            <Link to="/moderator/anmelden" className={styles.mobileLink} onClick={() => setMenuOpen(false)}>Moderieren</Link>
            <Link to="/zuschauen" className={styles.mobileLink} onClick={() => setMenuOpen(false)}>Zuschauen</Link>
            <Link to="/beitreten" className={styles.mobileLink} onClick={() => setMenuOpen(false)}>Beitreten</Link>
          </nav>
        </div>
      )}
    </header>
  );
}
