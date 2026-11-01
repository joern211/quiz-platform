import { useRef, useState } from 'react';
import type { CoreRuntimeProjection } from '@quiz/shared';
import { Button } from '@quiz/ui';
import { emitCommand, getSocket } from '../lib/socket';
export function RecoveryControl({ projection }: { projection: CoreRuntimeProjection }) {
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const busy = useRef(false);
  if (!projection.recoveryRequired) return null;
  return <section className="notice notice--warn" style={{ flexDirection: 'column', gap: 'var(--space-3)' }} aria-label="Wiederherstellung">
    <p role="alert"><span aria-hidden="true">⚠ </span>Das Spiel wurde angehalten. Der gespeicherte Zustand muss geprüft werden.</p>
    {projection.informationRole === 'HOST' && <Button loading={pending} onClick={() => {
      if (busy.current) return; busy.current = true; setPending(true); setError('');
      emitCommand(getSocket(), 'game:recovery:command', { roomCode: projection.roomCode, runIndex: projection.runIndex, gameStateVersion: projection.stateVersion, operation: 'RESTORE_REPLAY' },
        `${projection.roomCode}:recovery:${projection.runIndex}:${projection.stateVersion}`, response => {
          busy.current = false; setPending(false);
          if (!response.success) setError('Wiederherstellung nicht bestätigt. Ohne gültigen Nachweis bleibt das Spiel angehalten.');
        });
    }}>{pending ? 'Wird geprüft …' : 'Aus geprüftem Spielprotokoll wiederherstellen'}</Button>}
    {error && <p role="alert" style={{ color: 'var(--fg)' }}>{error}</p>}
  </section>;
}
