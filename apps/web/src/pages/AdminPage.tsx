// ============================================================
// Admin Page
// ============================================================

import { Card, Button } from '@quiz/ui';

export function AdminPage() {
  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '2rem' }}>
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
          (Phase 9 - kommt in einer späteren Version)
        </p>
      </Card>
      <div style={{ marginTop: '2rem' }}>
        <Button variant="secondary" onClick={() => history.back()}>
          Zurück
        </Button>
      </div>
    </div>
  );
}
