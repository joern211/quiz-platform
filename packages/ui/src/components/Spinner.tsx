// ============================================================
// Loading Spinner Component
// ============================================================

import styles from './Spinner.module.css';

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  label?: string;
}

export function Spinner({ size = 'md', label = 'Lädt...' }: SpinnerProps) {
  return (
    <div className={styles.container}>
      <div className={`${styles.spinner} ${styles[size]}`} />
      {label && <p className={styles.label}>{label}</p>}
    </div>
  );
}
