import type { useGameCore } from '../hooks/useGameCore';

/** Visible explanation and a reachable re-read while the game controls are withdrawn because the core read failed. */
export function CoreReadNotice({ core }: { core: Pick<ReturnType<typeof useGameCore>, 'status' | 'refresh'> }) {
  if (core.status === 'loading' || core.status === 'ready') return null;
  const text = core.status === 'throttled' ? 'Zu viele Anfragen in kurzer Zeit. Die Spielsteuerung ist kurz gesperrt und wird automatisch neu geladen.'
    : core.status === 'denied' ? 'Für diese Ansicht fehlt aktuell die Berechtigung oder die Verbindung zum Raum. Die Steuerung bleibt gesperrt.'
    : 'Der Spielzustand konnte nicht geladen werden. Die Steuerung bleibt gesperrt.';
  return <div role="alert"><p>{text}</p><button type="button" onClick={core.refresh}>Erneut laden</button></div>;
}
