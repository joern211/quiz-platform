// ============================================================
// Buzzer Button Component
// ============================================================

import { useState, useCallback, useEffect } from 'react';
import styles from './BuzzerButton.module.css';

interface BuzzerButtonProps {
  onBuzz: () => void;
  disabled?: boolean;
  label?: string;
  winner?: boolean;
  open?: boolean;
}

export function BuzzerButton({ 
  onBuzz, 
  disabled = false, 
  label = 'BUZZ!',
  winner = false,
  open = true
}: BuzzerButtonProps) {
  const [pressed, setPressed] = useState(false);
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || !open) return;
    
    setPressed(true);
    onBuzz();
    
    // Add ripple effect
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const newRipple = { id: Date.now(), x, y };
    
    setRipples(prev => [...prev, newRipple]);
    
    setTimeout(() => {
      setRipples(prev => prev.filter(r => r.id !== newRipple.id));
    }, 600);
    
    setTimeout(() => setPressed(false), 200);
  }, [disabled, open, onBuzz]);

  // Keyboard support
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !disabled && open) {
        e.preventDefault();
        setPressed(true);
        onBuzz();
        setTimeout(() => setPressed(false), 200);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [disabled, open, onBuzz]);

  const classes = [
    styles.buzzer,
    pressed ? styles.pressed : '',
    winner ? styles.winner : '',
    !open ? styles.closed : '',
    disabled ? styles.disabled : '',
  ].filter(Boolean).join(' ');

  return (
    <button
      className={classes}
      onClick={handleClick}
      disabled={disabled || !open}
      aria-label={label}
    >
      <span className={styles.ripples}>
        {ripples.map(ripple => (
          <span
            key={ripple.id}
            className={styles.ripple}
            style={{ left: ripple.x, top: ripple.y }}
          />
        ))}
      </span>
      <span className={styles.label}>{label}</span>
    </button>
  );
}
