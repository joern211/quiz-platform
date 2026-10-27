import { RoomPolicySchema, type BlueprintRoomSettings } from '@quiz/shared';
import styles from '../pages/ContentPage.module.css';
const defaults = RoomPolicySchema.parse({});
export function SetupRoomRules({ value, onChange, pinPresent = false }: { pinPresent?: boolean; value: BlueprintRoomSettings; onChange: (value: BlueprintRoomSettings) => void }) {
  const policy = { ...defaults, playerAccess: pinPresent ? 'PIN_PROTECTED' as const : 'PUBLIC_JOIN' as const, viewerAccess: pinPresent && value.viewerRequiresPin !== false ? 'PIN_PROTECTED' as const : 'PUBLIC_JOIN' as const, ...value.roomPolicy };
  const update = (key: keyof typeof policy, next: unknown) => onChange({ ...value, roomPolicy: { ...policy, [key]: next } });
  return <details className={styles.panel}><summary>Erweiterte Raumregeln</summary>
    {([['cameraEnabled', 'Kameras erlauben'], ['lobbyChatEnabled', 'Lobbychat erlauben'], ['isPublic', 'Öffentlich auffindbar'], ['viewerRequiresPin', 'Zuschauer benötigen eine PIN']] as const).map(([key, label]) => <label className={styles.check} key={key}><input type="checkbox" checked={value[key] ?? (key !== 'cameraEnabled')} onChange={e => onChange({ ...value, [key]: e.target.checked })} />{label}</label>)}
    <label>Zuschauerlimit<input type="number" min={0} max={500} value={value.viewerLimit ?? 50} onChange={e => onChange({ ...value, viewerLimit: Number(e.target.value) })} /></label>
    {([['allowLateJoin', 'Späteren Einstieg erlauben'], ['waitlist', 'Warteliste erlauben'], ['coHostEnabled', 'Co-Host erlauben'], ['allowTeamReshuffleBetweenRounds', 'Teams zwischen Runden neu mischen']] as const).map(([key, label]) => <label className={styles.check} key={key}><input type="checkbox" checked={policy[key]} onChange={e => update(key, e.target.checked)} />{label}</label>)}
    <label>Bereitschaftsregel<select aria-label="Bereitschaftsregel" value={policy.readyRule} onChange={e => update('readyRule', e.target.value)}><option value="ALL_READY_REQUIRED">Alle müssen bereit sein</option><option value="HOST_CAN_OVERRIDE">Host kann übergehen</option><option value="READY_CHECK_DISABLED">Ohne Bereitschaftsprüfung</option></select></label>
    <label>Teammodus<select aria-label="Teammodus" value={policy.teamMode} onChange={e => update('teamMode', e.target.value)}>{['OFF', 'MANUAL', 'RANDOM', 'SELF_SELECT', 'ROTATION'].map(v => <option key={v}>{v}</option>)}</select></label>
    {policy.teamMode !== 'OFF' && <><label>Anzahl Teams<input type="number" min={2} max={100} value={policy.teamCount} onChange={e => update('teamCount', Number(e.target.value))} /></label>
      <label>Minimale Teamgröße<input type="number" min={1} max={100} value={policy.minTeamSize} onChange={e => update('minTeamSize', Number(e.target.value))} /></label>
      <label>Maximale Teamgröße<input type="number" min={1} max={100} value={policy.maxTeamSize} onChange={e => update('maxTeamSize', Number(e.target.value))} /></label>
      <label>Teamgleichheit<select aria-label="Teamgleichheit" value={policy.equality} onChange={e => update('equality', e.target.value)}>{['REQUIRED', 'WARN', 'ANY'].map(v => <option key={v}>{v}</option>)}</select></label>
      <label>Punktewertung<select aria-label="Punktewertung" value={policy.scoring} onChange={e => update('scoring', e.target.value)}><option value="INDIVIDUAL_SCORE">Einzelpunkte</option><option value="TEAM_SCORE">Teampunkte</option></select></label></>}
    {(['playerAccess', 'viewerAccess'] as const).map(key => <label key={key}>{key === 'playerAccess' ? 'Spielerzugang' : 'Zuschauerzugang'}<select aria-label={key === 'playerAccess' ? 'Spielerzugang' : 'Zuschauerzugang'} value={policy[key]} onChange={e => update(key, e.target.value)}>{['PUBLIC_JOIN', 'PIN_PROTECTED', 'APPROVAL_REQUIRED', 'INVITE_ONLY'].map(v => <option key={v}>{v}</option>)}</select></label>)}
    <label>Host-Verbindungsfrist (Sekunden)<input type="number" min={1} max={86400} value={policy.hostGraceMs / 1000} onChange={e => update('hostGraceMs', Number(e.target.value) * 1000)} /></label>
    {!RoomPolicySchema.safeParse(policy).success && <p role="alert">Bitte Teamgrößen, Grenzen und Raumregeln prüfen.</p>}
  </details>;
}
