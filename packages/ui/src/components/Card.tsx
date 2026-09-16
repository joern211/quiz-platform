// ============================================================
// Card Component
// ============================================================

import { HTMLAttributes, forwardRef, ReactNode } from 'react';
import styles from './Card.module.css';

type CardVariant = 'default' | 'elevated' | 'bordered';
type CardPadding = 'none' | 'sm' | 'md' | 'lg';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: CardPadding;
  interactive?: boolean;
  selected?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ 
    variant = 'default', 
    padding = 'md', 
    interactive = false,
    selected = false,
    className = '',
    children,
    ...props 
  }, ref) => {
    const classes = [
      styles.card,
      styles[variant],
      styles[`padding-${padding}`],
      interactive ? styles.interactive : '',
      selected ? styles.selected : '',
      className,
    ].filter(Boolean).join(' ');

    return (
      <div ref={ref} className={classes} {...props}>
        {children}
      </div>
    );
  }
);

Card.displayName = 'Card';

// Card Header
interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

export const CardHeader = ({ title, subtitle, action, className = '', ...props }: CardHeaderProps) => (
  <div className={`${styles.header} ${className}`} {...props}>
    <div className={styles.headerText}>
      <h3 className={styles.title}>{title}</h3>
      {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
    </div>
    {action && <div className={styles.action}>{action}</div>}
  </div>
);

// Card Content
export const CardContent = ({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={`${styles.content} ${className}`} {...props}>
    {children}
  </div>
);

// Card Footer
export const CardFooter = ({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={`${styles.footer} ${className}`} {...props}>
    {children}
  </div>
);
