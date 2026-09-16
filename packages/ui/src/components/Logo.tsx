// ============================================================
// Logo Component
// ============================================================

import { Link } from 'react-router-dom';
import styles from './Logo.module.css';

interface LogoProps {
  showText?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export function Logo({ showText = true, size = 'md' }: LogoProps) {
  return (
    <Link to="/" className={`${styles.logo} ${styles[size]}`}>
      <svg 
        className={styles.icon}
        viewBox="0 0 40 40" 
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Quiz mark / lightbulb shape */}
        <circle cx="20" cy="20" r="18" stroke="currentColor" strokeWidth="2" fill="none" />
        <path 
          d="M20 8 L20 14 M20 26 L20 32 M8 20 L14 20 M26 20 L32 20" 
          stroke="currentColor" 
          strokeWidth="2" 
          strokeLinecap="round"
        />
        <circle cx="20" cy="20" r="8" fill="currentColor" opacity="0.3" />
        <text 
          x="20" 
          y="24" 
          textAnchor="middle" 
          fill="currentColor" 
          fontSize="14" 
          fontWeight="bold"
        >
          Q
        </text>
      </svg>
      {showText && (
        <span className={styles.text}>Online Quiz Plattform</span>
      )}
    </Link>
  );
}
