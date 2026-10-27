import { useState } from 'react';
import { emitCommand, getSocket } from '../lib/socket';

export function BuzzerOverride({ roomCode, stateVersion, runIndex, playerNames, winnerId, excludedIds = [] }: {
  roomCode: string; stateVersion: number; runIndex: number; playerNames: Record<string, string>; winnerId: string | null; excludedIds?: string[];
}) {
  const [participantId, setParticipantId] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const candidates = Object.entries(playerNames).filter(([id]) => id !== winnerId && !excludedIds.includes(id));
  if (!candidates.length) return null;
  return <form onSubmit={event => {
    event.preventDefault();
    if (pending || !candidates.some(([id]) => id === participantId)) return;
    setPending(true); setError('');
    emitCommand(getSocket(), 'game:buzzer:override', { participantId, reason: reason.trim(), gameStateVersion: stateVersion, runIndex },
      `${roomCode}:buzzer:override:${runIndex}:${stateVersion}:${participantId}`, response => {
        setPending(false);
        if (response.success) { setParticipantId(''); setReason(''); }
        else setError('Korrektur fehlgeschlagen. Prüfe den aktuellen Spielstand und deine Berechtigung.');
      });
  }}>
    <p>Buzzer-Gewinner korrigieren</p>
    <label>Neuer Gewinner <select value={participantId} disabled={pending} onChange={event => setParticipantId(event.target.value)}>
      <option value="">Spieler auswählen</option>
      {candidates.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select></label>
    <label>Grund (optional) <input value={reason} maxLength={300} disabled={pending} onChange={event => setReason(event.target.value)} /></label>
    <button type="submit" disabled={pending || !candidates.some(([id]) => id === participantId)}>{pending ? 'Wird gespeichert …' : 'Gewinner korrigieren'}</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
