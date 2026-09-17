// ============================================================
// 404 Not Found Page – v0.2.0 (CSS Modules + accessibility)
// ============================================================

import { Link } from 'react-router-dom';
import { Card, Button } from '@quiz/ui';
import styles from './NotFoundPage.module.css';

export function NotFoundPage() {
  return (
    <div className={styles.page}>
      <p className={styles.errorCode} aria-label="404 — Seite nicht gefunden">404</p>
      <Card>
        <h2>Seite nicht gefunden</h2>
        <p>Die gesuchte Seite existiert nicht oder wurde verschoben.</p>
        <div className={styles.actions}>
          <Link to="/">
            <Button>Zur Startseite</Button>
          </Link>
          <Link to="/kategorien">
            <Button variant="secondary">Kategorien</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
