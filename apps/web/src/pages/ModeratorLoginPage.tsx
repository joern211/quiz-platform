// ============================================================
// Moderator Login Page
// ============================================================

import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Card, Button, Input } from '@quiz/ui';
import styles from './ModeratorLoginPage.module.css';

export function ModeratorLoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Get return URL from query params
  const returnUrl = new URLSearchParams(location.search).get('return') || '/kategorien';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'include',
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Anmeldung fehlgeschlagen');
        setLoading(false);
        return;
      }

      // Success - redirect
      navigate(returnUrl);
    } catch (err) {
      setError('Verbindungsfehler. Bitte versuche es erneut.');
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <Card padding="lg" className={styles.card}>
        <h1 className={styles.title}>Moderator-Anmeldung</h1>
        <p className={styles.subtitle}>
          Melde dich an, um Räume zu erstellen und Spiele zu moderieren
        </p>

        <form onSubmit={handleSubmit} className={styles.form}>
          <Input
            label="Benutzername"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
            placeholder="Dein Benutzername"
          />

          <Input
            label="Passwort"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            placeholder="Dein Passwort"
          />

          {error && <p className={styles.error}>{error}</p>}

          <Button type="submit" fullWidth loading={loading}>
            Anmelden
          </Button>
        </form>

        <div className={styles.hint}>
          <p>Noch kein Konto? Die erste Anmeldung erstellt ein Admin-Konto.</p>
        </div>
      </Card>
    </div>
  );
}
