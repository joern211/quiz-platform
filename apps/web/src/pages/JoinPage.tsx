// ============================================================
// Join Page (Quick join by room code)
// ============================================================

import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Card, Button, Input } from '@quiz/ui';
import styles from './JoinPage.module.css';

export function JoinPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Pre-fill code from router state (e.g. from RoomsPage)
  useState(() => {
    const state = location.state as { code?: string } | null;
    if (state?.code) {
      // Format NNN-NNN
      const c = state.code.replace(/\D/g, '');
      if (c.length <= 3) setCode(c);
      else setCode(`${c.slice(0, 3)}-${c.slice(3, 6)}`);
    }
  });

  const formatCode = (value: string) => {
    const digits = value.replace(/\D/g, '');
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
      const res = await fetch(`/api/v1/rooms/${cleanCode}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pin: pin || undefined }),
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.error?.message || json.error || 'Beitritt fehlgeschlagen');
        setLoading(false);
        return;
      }

      // Store both rejoinToken and participationId
      localStorage.setItem('rejoinToken', json.data.rejoinToken || '');
      localStorage.setItem('participationId', json.data.participationId || '');
      localStorage.setItem('roomCode', cleanCode);
      navigate(`/raum/${cleanCode}/lobby`);
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
          Gib den 6-stelligen Raumcode ein, den du vom Moderator erhalten hast.
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
