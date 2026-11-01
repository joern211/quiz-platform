// ============================================================
// Timer Component
// ============================================================

import { useEffect, useState, useCallback, useRef } from 'react';
import styles from './Timer.module.css';

interface TimerProps {
  endsAt: number; // Unix timestamp in ms
  onExpire?: () => void;
  paused?: boolean;
  size?: 'sm' | 'md' | 'lg';
  showNumbers?: boolean;
}

export function Timer({ 
  endsAt, 
  onExpire, 
  paused = false, 
  size = 'md',
  showNumbers = true 
}: TimerProps) {
  const [remaining, setRemaining] = useState<number>(0);
  const [expired, setExpired] = useState(false);
  // Gesamtdauer = Restzeit beim ersten Anzeigen dieses Endzeitpunkts
  const totalRef = useRef<{ endsAt: number; total: number } | null>(null);
  if (!totalRef.current || totalRef.current.endsAt !== endsAt) {
    totalRef.current = { endsAt, total: Math.max(1, endsAt - Date.now()) };
  }

  const calculateRemaining = useCallback(() => {
    return Math.max(0, endsAt - Date.now());
  }, [endsAt]);

  useEffect(() => {
    // Calculate initial remaining
    const initial = calculateRemaining();
    setRemaining(initial);
    
    if (initial <= 0) {
      setExpired(true);
      return;
    }

    // Update every 50ms for smooth animation
    const interval = setInterval(() => {
      const newRemaining = calculateRemaining();
      setRemaining(newRemaining);
      
      if (newRemaining <= 0 && !expired) {
        setExpired(true);
        onExpire?.();
        clearInterval(interval);
      }
    }, 50);

    return () => clearInterval(interval);
  }, [calculateRemaining, onExpire, expired]);

  // Calculate percentage for progress bar
  const totalDuration = totalRef.current.total;
  const percentage = paused ? 0 : Math.min(100, (remaining / totalDuration) * 100);
  
  // Format remaining time
  const seconds = Math.ceil(remaining / 1000);
  const displaySeconds = Math.max(0, seconds);

  // Determine urgency level
  const isUrgent = remaining <= 5000 && remaining > 0;
  const isCritical = remaining <= 3000;

  return (
    <div className={`${styles.timer} ${styles[size]} ${expired ? styles.expired : ''}`}>
      <div className={styles.progressWrapper} aria-hidden="true">
        <div 
          className={`${styles.progress} ${isUrgent ? styles.urgent : ''} ${isCritical ? styles.critical : ''}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {showNumbers && (
        <span className={`${styles.seconds} ${isUrgent ? styles.urgentText : ''}`} role="timer" aria-label={`${displaySeconds} Sekunden verbleibend`}>
          {displaySeconds}
        </span>
      )}
    </div>
  );
}
