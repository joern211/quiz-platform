// ============================================================
// Footer Component – v0.2.0
// ============================================================

import styles from './Footer.module.css';

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.container}>
        <p className={styles.text}>
          Online Quiz Plattform — Mit Freunden spielen
        </p>
        <p className={styles.version}>v0.2.0</p>
      </div>
    </footer>
  );
}
