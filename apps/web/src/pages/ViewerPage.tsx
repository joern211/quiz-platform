// ============================================================
// Viewer Page – Zuschauer-Einstieg (Code-Eingabe)
// ============================================================

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Button, Input } from '@quiz/ui';
import styles from './ViewerPage.module.css';

export function ViewerPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!clean) {
      setError('Bitte gib einen Raumcode ein.');
      return;
    }
    setError('');
    navigate(`/zuschauen/${clean}/lobby`);
  };

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <h1 className={styles.title}>Zuschauen</h1>
        <p className={styles.subtitle}>
          Kein Account nötig — gib einfach den Raumcode ein, um einem Spiel zuzuschauen.
        </p>
      </div>

      <Card padding="lg" className={styles.card}>
        <form onSubmit={handleSubmit} className={styles.form}>
          <Input
            label="Raumcode"
            placeholder="z.B. 123-456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            error={error}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" variant="primary" size="lg">
            Zuschauen
          </Button>
        </form>
      </Card>

      <div className={styles.notice}>
        <p>
          <strong>Hinweis:</strong> Als Zuschauer kannst du das Spiel sehen, aber keine Eingaben machen.
        </p>
      </div>
    </div>
  );
}
