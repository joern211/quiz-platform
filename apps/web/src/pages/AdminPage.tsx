// ============================================================
// Admin Page – v0.2.0 (CSS Modules, no inline styles)
// ============================================================

import { Card, Button } from '@quiz/ui';
import styles from './AdminPage.module.css';

export function AdminPage() {
  return (
    <div className={styles.page}>
      <h1>Admin-Bereich</h1>
      <Card>
        <p>Der Admin-Bereich ermöglicht:</p>
        <ul>
          <li>Moderatorkonten verwalten</li>
          <li>Spielkatalogeinträge aktivieren/deaktivieren</li>
          <li>Fragenpools und Medien verwalten</li>
          <li>Backups erstellen und wiederherstellen</li>
          <li>Auditprotokolle einsehen</li>
        </ul>
        <p style={{ marginTop: '1rem', color: 'var(--muted)' }}>
          (Phase 9 — kommt in einer späteren Version)
        </p>
      </Card>
      <div className={styles.backButton}>
        <Button variant="secondary" onClick={() => history.back()}>
          Zurück
        </Button>
      </div>
    </div>
  );
}
