// ============================================================
// Join Page – v0.3.0 (P0-01: Name field, proper room code)
// ============================================================

import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Card, Button, Input } from '@quiz/ui';
import styles from './JoinPage.module.css';

// Normalize: strip all non-digits, then reformat as NNN-NNN
function normalizeCode(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 6);
  if (digits.length <= 3) return digits;
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

export function JoinPage() {
  const navigate = useNavigate();
  const location = useLocation();

  // Pre-fill from router state (e.g. RoomsPage click)
  const initialCode = (() => {
    const state = location.state as { code?: string } | null;
    return state?.code ? normalizeCode(state.code) : '';
  })();

  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Auto-format as user types: 123|123-4|56
    const formatted = normalizeCode(e.target.value);
    setCode(formatted);
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Send NNN-NNN format as-is to server (server normalizes)
    const codeToSend = code;
    if (codeToSend.length !== 7 || !codeToSend.match(/^\d{3}-\d{3}$/)) {
      setError('Bitte gib einen gültigen 6-stelligen Code ein');
      return;
    }
    if (!name.trim()) {
      setError('Bitte gib deinen Anzeigenamen ein');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/v1/rooms/${codeToSend}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          displayName: name.trim(),
          pin: pin || undefined,
        }),
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Beitritt fehlgeschlagen');
        setLoading(false);
        return;
      }

      const { rejoinToken, participationId, role } = json.data;

      // Persist to sessionStorage atomically - keep dash in room code
      // NNN-NNN with dash
      import('../lib/sessionStore').then(({ setSession }) => {
        setSession({
          rejoinToken: rejoinToken ?? null,
          participationId: participationId ?? null,
          roomCode: codeToSend, // NNN-NNN format
          role: role ?? null,
        });
      });

      // Navigate based on role - use route format from App.tsx
      const target =
        role === 'MODERATOR'
          ? `/moderator/raum/${codeToSend}/lobby`
          : `/raum/${codeToSend}/lobby`;

      navigate(target);
    } catch {
      setError('Verbindungsfehler');
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <Card padding="lg" className={styles.card}>
        <h1 className={styles.title}>Raum beitreten</h1>
        <p className={styles.subtitle}>
          Gib den Code ein, den du vom Moderator erhalten hast.
        </p>

        <form onSubmit={handleSubmit} className={styles.form} noValidate>
          <Input
            label="Anzeigename"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(''); }}
            placeholder="Dein Name"
            maxLength={30}
            autoFocus
          />

          <Input
            label="Raumcode"
            value={code}
            onChange={handleCodeChange}
            placeholder="123-456"
            inputMode="numeric"
            maxLength={7}
          />

          <Input
            label="PIN (falls erforderlich)"
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
            maxLength={6}
          />

          {error && <p className={styles.error} role="alert">{error}</p>}

          <Button type="submit" fullWidth loading={loading} disabled={loading}>
            Beitreten
          </Button>
        </form>

        <p className={styles.hint}>
          Keinen Code? <a href="/raeume">Öffentliche Räume anzeigen</a>
        </p>
      </Card>
    </div>
  );
}
