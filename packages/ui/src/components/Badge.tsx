// ============================================================
// Badge Component
// ============================================================

import { HTMLAttributes } from 'react';
import styles from './Badge.module.css';

type BadgeVariant = 'success' | 'warning' | 'danger' | 'muted' | 'accent';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: 'sm' | 'md';
}

export function Badge({ 
  variant = 'muted', 
  size = 'sm',
  className = '',
  children,
  ...props 
}: BadgeProps) {
  return (
    <span 
      className={`${styles.badge} ${styles[variant]} ${styles[size]} ${className}`}
      {...props}
    >
      {children}
    </span>
  );
}
