// ============================================================
// 404 Not Found Page
// ============================================================

import { Link } from 'react-router-dom';
import { Card, Button } from '@quiz/ui';

export function NotFoundPage() {
  return (
    <div style={{ 
      maxWidth: '500px', 
      margin: '4rem auto', 
      textAlign: 'center',
      padding: '2rem'
    }}>
      <h1 style={{ 
        fontSize: '6rem', 
        margin: '0',
        background: 'linear-gradient(135deg, var(--accent), var(--accent-strong))',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
      }}>
        404
      </h1>
      <Card>
        <h2>Seite nicht gefunden</h2>
        <p>Die gesuchte Seite existiert nicht oder wurde verschoben.</p>
        <div style={{ marginTop: '1.5rem', display: 'flex', gap: '1rem', justifyContent: 'center' }}>
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
