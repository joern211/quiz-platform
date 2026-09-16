// ============================================================
// Header Component
// ============================================================

import { Link } from 'react-router-dom';
import { Logo, useTheme } from '@quiz/ui';
import styles from './Header.module.css';

export function Header() {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className={styles.header}>
      <div className={styles.container}>
        <Logo />
        
        <nav className={styles.nav}>
          <Link to="/kategorien" className={styles.link}>Spiele</Link>
          <Link to="/raeume" className={styles.link}>Räume</Link>
          <Link to="/moderator/anmelden" className={styles.link}>Moderieren</Link>
        </nav>

        <div className={styles.actions}>
          <button
            onClick={toggleTheme}
            className={styles.themeToggle}
            aria-label={theme === 'dark' ? 'Zum hellen Theme wechseln' : 'Zum dunklen Theme wechseln'}
            title={theme === 'dark' ? 'Heller Modus' : 'Dunkler Modus'}
          >
            {theme === 'dark' ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="5" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
