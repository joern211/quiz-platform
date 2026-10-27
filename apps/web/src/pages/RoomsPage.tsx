// ============================================================
// Rooms Page (list active public rooms)
// ============================================================

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Card, Button, Badge } from '@quiz/ui';
import { PublicRoomSummarySchema, type PublicRoomSummary } from '@quiz/shared';
import { roomsApi } from '../lib/api';
import styles from './RoomsPage.module.css';

const lifecycleLabels = { SCHEDULED: 'Geplant', LOBBY_OPEN: 'Offen', LOBBY_LOCKED: 'Gesperrt', GAME_ACTIVE: 'Läuft', PAUSED: 'Pausiert' };

export function RoomsPage() {
  const [rooms, setRooms] = useState<PublicRoomSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchRooms();
  }, []);

  const fetchRooms = async () => {
    setLoading(true);
    setError('');
    try {
      const json = await roomsApi.listPublic();
      if (!json.success) throw new Error(json.error?.message ?? 'Räume konnten nicht geladen werden.');
      setRooms(PublicRoomSummarySchema.array().parse(json.data));
    } catch {
      setError('Räume konnten nicht geladen werden. Bitte erneut versuchen.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Öffentliche Räume</h1>
        <Link to="/moderator/anmelden">
          <Button>Raum erstellen</Button>
        </Link>
      </div>

      {loading ? (
        <p className={styles.loading}>Laden...</p>
      ) : error ? (
        <Card padding="lg"><p role="alert">{error}</p><Button onClick={fetchRooms}>Erneut laden</Button></Card>
      ) : rooms.length === 0 ? (
        <Card padding="lg" className={styles.empty}>
          <h2>Keine aktiven Räume</h2>
          <p>Werde der Erste, der einen Raum erstellt!</p>
          <Link to="/kategorien">
            <Button>Spiel wählen</Button>
          </Link>
        </Card>
      ) : (
        <div className={styles.grid}>
          {rooms.map((room) => (
            <Card key={room.code} padding="md" className={styles.roomCard}>
              <div className={styles.roomHeader}>
                <h3>{room.roomName || 'Unbenannter Raum'}</h3>
                <Badge variant={room.lifecycle === 'LOBBY_OPEN' ? 'success' : 'warning'}>
                  {lifecycleLabels[room.lifecycle]}
                </Badge>
              </div>
              
              <p className={styles.game}>{room.game.name}</p>
              
              <div className={styles.roomMeta}>
                <span>👥 {room.playerCount}/{room.maxPlayers}</span>
                {room.allowViewers && <span>{room.viewerCount} Zuschauer</span>}
              </div>
              {room.scheduledAt && <p>Geplant: {new Date(room.scheduledAt).toLocaleString('de-DE')}</p>}
              {room.accessMode === 'PIN_PROTECTED' && <p>PIN erforderlich</p>}
              {room.accessMode === 'APPROVAL_REQUIRED' && <p>Freigabe durch den Host erforderlich</p>}
              {room.canJoin ? <Link to={`/beitreten?code=${room.code}`}>
                <Button fullWidth variant="secondary">{room.waitlist ? 'Auf die Warteliste' : 'Beitreten'}</Button>
              </Link> : <p>{room.accessMode === 'INVITE_ONLY' ? 'Nur mit Einladung' : room.playerCount >= room.maxPlayers ? 'Raum voll' : 'Beitritt derzeit geschlossen'}</p>}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
