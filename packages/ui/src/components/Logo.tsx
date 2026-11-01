// ============================================================
// Logo – Midnight-Wortmarke (reines Bild + Text, kein eigener Link,
// damit es in Links eingebettet werden kann, ohne <a> zu verschachteln)
// ============================================================

import styles from './Logo.module.css';

interface LogoProps {
  showText?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export function Logo({ showText = true, size = 'md' }: LogoProps) {
  return (
    <span className={`${styles.logo} ${styles[size]}`}>
      <span className={styles.mark} aria-hidden="true">q</span>
      {showText && <span className={styles.text}>Online Quiz Plattform</span>}
    </span>
  );
}
