// ============================================================
// Rooms Page (list active public rooms)
// ============================================================

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Card, Button, Badge } from '@quiz/ui';
import styles from './RoomsPage.module.css';

interface Room {
  code: string;
  roomName: string;
  game: { name: string; slug: string };
  playerCount: number;
  maxPlayers: number;
  status: string;
  createdAt: string;
}

export function RoomsPage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchRooms();
  }, []);

  const fetchRooms = async () => {
    try {
      const res = await fetch('/api/v1/rooms/public');
      const data = await res.json();
      setRooms(data.rooms || []);
    } catch (err) {
      console.error('Failed to fetch rooms');
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
                <Badge variant={room.status === 'LOBBY' ? 'success' : 'warning'}>
                  {room.status === 'LOBBY' ? 'Offen' : 'Läuft'}
                </Badge>
              </div>
              
              <p className={styles.game}>{room.game.name}</p>
              
              <div className={styles.roomMeta}>
                <span>👥 {room.playerCount}/{room.maxPlayers}</span>
                <span>📅 {new Date(room.createdAt).toLocaleTimeString('de')}</span>
              </div>

              <Link to={`/beitreten`} state={{ code: room.code }}>
                <Button fullWidth variant="secondary">Beitreten</Button>
              </Link>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
