// ============================================================
// Watch Page (start page for viewers)
// ============================================================

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Button, Input } from '@quiz/ui';
import styles from './WatchPage.module.css';

export function WatchPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');

  const formatCode = (value: string) => {
    const digits = value.replace(/\D/g, '');
    if (digits.length <= 3) return digits;
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}`;
  };

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCode(formatCode(e.target.value));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = code.replace(/-/g, '');
    if (cleanCode.length === 6) {
      navigate(`/zuschauen/${code}`);
    }
  };

  return (
    <div className={styles.page}>
      <Card padding="lg" className={styles.card}>
        <h1 className={styles.title}>Zuschauen</h1>
        <p className={styles.subtitle}>
          Gib den Raumcode ein, um einem Spiel zuzusehen
        </p>

        <form onSubmit={handleSubmit} className={styles.form}>
          <Input
            label="Raumcode"
            value={code}
            onChange={handleCodeChange}
            placeholder="123-456"
            maxLength={7}
            inputMode="numeric"
          />
          <Button type="submit" fullWidth>
            Zuschauen
          </Button>
        </form>
      </Card>
    </div>
  );
}
