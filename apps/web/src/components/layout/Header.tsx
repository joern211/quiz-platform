// ============================================================
// Header – Midnight-Topbar (Navigation bleibt auch mobil oben)
// ============================================================

import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Logo, useTheme } from '@quiz/ui';
import { getActiveRoomCode } from '../../lib/socket';
import { AppearanceSettings } from '../AppearanceSettings';
import styles from './Header.module.css';

const NAV_ITEMS = [
  { to: '/kategorien', label: 'Spiele' },
  { to: '/moderator/raeume', label: 'Räume' },
  { to: '/inhalte', label: 'Fragen & Pools' },
  { to: '/moderator/anmelden', label: 'Moderieren' },
  { to: '/zuschauen', label: 'Zuschauen' },
];

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M19 5l-1.4 1.4M6.4 17.6 5 19" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 14a8 8 0 0 1-10-10A8 8 0 1 0 20 14Z" />
    </svg>
  );
}
function PaletteIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.9 1.4-1.8-.4-1.2.4-2.2 1.6-2.2H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10Z" />
      <circle cx="7.5" cy="11" r="1.2" fill="currentColor" /><circle cx="10.5" cy="7" r="1.2" fill="currentColor" /><circle cx="15" cy="7.5" r="1.2" fill="currentColor" />
    </svg>
  );
}

export function Header() {
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeRoomCode, setActiveRoomCode] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Track active room
  useEffect(() => {
    function checkActiveRoom() {
      setActiveRoomCode(getActiveRoomCode());
    }
    checkActiveRoom();
    const handler = () => checkActiveRoom();
    window.addEventListener('storage', handler);
    // Poll for sessionStorage changes within the same tab
    const interval = setInterval(checkActiveRoom, 1000);
    return () => {
      window.removeEventListener('storage', handler);
      clearInterval(interval);
    };
  }, []);

  // Menü schließt bei Navigation
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  const closeMenu = useCallback((returnFocus: boolean) => {
    setMenuOpen(false);
    if (returnFocus) toggleRef.current?.focus();
  }, []);

  // Close on Escape (nicht, wenn der Darstellungsdialog offen ist – der hat eigenes Escape)
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !settingsOpen) closeMenu(true);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [menuOpen, settingsOpen, closeMenu]);

  // Close on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || toggleRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // Focus first item when menu opens
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLElement>('a, button')?.focus();
  }, [menuOpen]);

  function getBackUrl() {
    const code = activeRoomCode;
    if (!code) return '/';
    const role = sessionStorage.getItem('qp_role');
    if (role === 'HOST') return `/moderator/raum/${code}/lobby`;
    return `/raum/${code}/lobby`;
  }

  const themeLabel = theme === 'dark' ? 'Zum hellen Theme wechseln' : 'Zum dunklen Theme wechseln';

  return (
    <header className={styles.header}>
      <div className={`${styles.container} ${activeRoomCode ? styles.withRoom : ''}`}>
        <Link to="/" className={styles.logo} aria-label="Online Quiz Plattform – zur Startseite">
          <Logo />
        </Link>

        {activeRoomCode && (
          <Link to={getBackUrl()} className={styles.backLink}>
            <span aria-hidden="true">←</span> Zurück zum Raum
          </Link>
        )}

        <nav className={styles.nav} aria-label="Hauptnavigation">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `${styles.link} ${isActive ? styles.current : ''}`}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className={styles.actions}>
          <Link to="/beitreten" className={styles.joinLink}>Raum beitreten</Link>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className={styles.iconButton}
            aria-label="Darstellung: Hell/Dunkel und Akzentfarbe"
            aria-haspopup="dialog"
            title="Darstellung"
          >
            <PaletteIcon />
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            className={styles.iconButton}
            aria-label={themeLabel}
            title={theme === 'dark' ? 'Heller Modus' : 'Dunkler Modus'}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>

          <button
            ref={toggleRef}
            type="button"
            className={styles.menuToggle}
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label={menuOpen ? 'Menü schließen' : 'Menü öffnen'}
          >
            {menuOpen ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" width="22" height="22"><path d="M18 6 6 18M6 6l12 12" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" width="22" height="22"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
            )}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div id="mobile-menu" ref={menuRef} className={styles.mobileMenu}>
          <nav className={styles.mobileNav} aria-label="Navigation">
            {activeRoomCode && (
              <Link to={getBackUrl()} className={`${styles.mobileLink} ${styles.mobileBack}`} onClick={() => closeMenu(false)}>
                <span aria-hidden="true">←</span> Zurück zum Raum
              </Link>
            )}
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => `${styles.mobileLink} ${isActive ? styles.current : ''}`} onClick={() => closeMenu(false)}>
                {item.label}
              </NavLink>
            ))}
            <Link to="/beitreten" className={`${styles.mobileLink} ${styles.mobileJoin}`} onClick={() => closeMenu(false)}>Raum beitreten</Link>
            <button type="button" className={styles.mobileLink} onClick={() => { closeMenu(true); setSettingsOpen(true); }}>
              <PaletteIcon /> Darstellung
            </button>
          </nav>
        </div>
      )}

      <AppearanceSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}
