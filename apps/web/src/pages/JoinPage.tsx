// ============================================================
// Join Page (Quick join by room code)
// ============================================================

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Button, Input } from '@quiz/ui';
import styles from './JoinPage.module.css';

export function JoinPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const formatCode = (value: string) => {
    // Remove non-digits
    const digits = value.replace(/\D/g, '');
    // Format as NNN-NNN
    if (digits.length <= 3) return digits;
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}`;
  };

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCode(formatCode(e.target.value));
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const cleanCode = code.replace(/-/g, '');
    if (cleanCode.length !== 6) {
      setError('Bitte gib einen gültigen 6-stelligen Code ein');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await fetch(`/api/v1/rooms/${code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pin: pin || undefined }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Beitritt fehlgeschlagen');
        setLoading(false);
        return;
      }

      // Store token and navigate to lobby
      localStorage.setItem('rejoinToken', data.rejoinToken);
      navigate(`/raum/${code}/lobby`);
    } catch (err) {
      setError('Verbindungsfehler');
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <Card padding="lg" className={styles.card}>
        <h1 className={styles.title}>Raum beitreten</h1>
        <p className={styles.subtitle}>
          Gib den 6-stelligen Raumcode ein, den du vom Moderator erhalten hast
        </p>

        <form onSubmit={handleSubmit} className={styles.form}>
          <Input
            label="Raumcode"
            value={code}
            onChange={handleCodeChange}
            placeholder="123-456"
            maxLength={7}
            inputMode="numeric"
            autoFocus
            error={error}
          />

          <Input
            label="PIN (falls erforderlich)"
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
            maxLength={4}
          />

          <Button type="submit" fullWidth loading={loading}>
            Beitreten
          </Button>
        </form>

        <div className={styles.hint}>
          <p>Keinen Code? <a href="/raeume">Öffentliche Räume anzeigen</a></p>
        </div>
      </Card>
    </div>
  );
}
