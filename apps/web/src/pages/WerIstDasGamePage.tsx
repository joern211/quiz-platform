import { useParams } from 'react-router-dom';
import { GameShell } from '../components/GameShell';
import { getSessionData, type PlayerRole } from '../lib/socket';
import { useWerIstDas } from '../hooks/useWerIstDas';
import styles from './WerIstDasGamePage.module.css';

export function WerIstDasGamePage({ role }: { role: PlayerRole }) {
  const { code = '' } = useParams<{ code: string }>();
  const { state, connected, error, act, judge, end } = useWerIstDas(code, role);
  const self = getSessionData().participationId;
  const scores = Object.entries(state?.scores ?? {}).sort((a, b) => b[1] - a[1]);
  const canBuzz = role === 'PLAYER' && state?.buzzerOpen && !state.excluded;

  return <GameShell role={role.toLowerCase() as 'moderator' | 'player' | 'viewer'}
    roomCode={code} phase={state?.phase} connected={connected} error={error}>
    <div className={styles.layout}>
      <section className={styles.main}>
        <h1>Wer ist das?</h1>
        {!state && <p>Spielstand wird geladen …</p>}
        {state && <>
          <p>Runde {state.roundIndex + 1} von {state.roundCount}</p>
          {state.phase === 'GAME_END' ? <h2>Spiel beendet · Ergebnis</h2> :
            <img className={styles.image} src={`/api/v1/media/${state.imageAssetId}`} alt="Errate die beiden Personen" />}
          {state.hintActive && <p className={styles.hint}>Hinweis aktiv: Eine richtige Person genügt für 1 Punkt.</p>}
          {state.phase === 'ANSWERING' && <p className={styles.turn}>
            {state.winnerId === self ? 'Du bist dran – antworte mündlich.' : `${state.winnerName ?? 'Ein Spieler'} antwortet.`}
          </p>}
          {state.phase === 'BUZZ_OPEN' && <p>Der Buzzer ist geöffnet.</p>}
          {role === 'PLAYER' && state.excluded && state.phase !== 'REVEAL' &&
            <p>Du bist für den Rest dieser Runde vom Buzzern ausgeschlossen.</p>}
          {role === 'PLAYER' && state.phase !== 'GAME_END' &&
            <button className={styles.buzz} disabled={!canBuzz} onClick={() => act('weristdas:buzz')}>
              {canBuzz ? 'BUZZERN' : state.excluded ? 'Ausgeschlossen' : 'Buzzer geschlossen'}
            </button>}
          {state.person1 && state.person2 && (role === 'MODERATOR' || state.revealed) &&
            <div className={styles.solution}>
              <strong>{role === 'MODERATOR' && !state.revealed ? 'Geheime Lösung' : 'Auflösung'}:</strong>
              <p>{state.person1} + {state.person2}</p>
              {role === 'MODERATOR' && ((state.aliases1?.length ?? 0) > 0 || (state.aliases2?.length ?? 0) > 0) &&
                <p>Alternativen: {state.aliases1?.join(', ')} · {state.aliases2?.join(', ')}</p>}
              {state.revealed && state.description && <p>{state.description}</p>}
            </div>}
          {role === 'MODERATOR' && state.phase !== 'GAME_END' && <div className={styles.controls}>
            <h2>Moderation</h2>
            {state.excludedPlayerIds?.length ? <p>Ausgeschlossen: {state.excludedPlayerIds.map(id => state.playerNames[id]).join(', ')}</p> : null}
            {state.phase === 'ROUND_READY' && <button onClick={() => act('weristdas:buzzer:open')}>Buzzer öffnen</button>}
            {['ROUND_READY', 'BUZZ_OPEN', 'ANSWERING'].includes(state.phase) && !state.hintActive &&
              <button onClick={() => act('weristdas:hint')}>Hinweis aktivieren</button>}
            {state.phase === 'ANSWERING' && <div className={styles.judges}>
              <p>{state.winnerName} bewerten:</p>
              <button onClick={() => judge('BOTH_CORRECT')}>Beide richtig · +3</button>
              {state.hintActive && <button onClick={() => judge('ONE_CORRECT')}>Eine richtig · +1</button>}
              <button onClick={() => judge('WRONG')}>Falsch · −1</button>
            </div>}
            {['ROUND_READY', 'BUZZ_OPEN'].includes(state.phase) &&
              <button onClick={() => act('weristdas:reveal')}>Auflösen</button>}
            {state.phase === 'REVEAL' && <button onClick={() => act('weristdas:next')}>
              {state.roundIndex + 1 === state.roundCount ? 'Ergebnis anzeigen' : 'Nächste Runde'}
            </button>}
            <button onClick={end}>Spiel beenden</button>
          </div>}
        </>}
      </section>
      <aside className={styles.scores}>
        <h2>{state?.phase === 'GAME_END' ? 'Rangliste' : 'Punktestand'}</h2>
        <ol>{scores.map(([id, score]) => <li key={id}>
          {state?.playerNames[id] ?? 'Spieler'}{id === self ? ' (Du)' : ''}: {score}
        </li>)}</ol>
      </aside>
    </div>
  </GameShell>;
}
