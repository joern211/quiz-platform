// TEST-ONLY harness for the N4 VoteForm. Never served by the app: it lives outside src/ and index.html
// and is not part of any build. Run: see docs/implementation/n4-voting-foundation/acceptance.md.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@quiz/ui';
import '@quiz/ui/styles/tokens.css';
import '../../src/index.css';
import { votingAbstainBallot, votingOptionBallot, type VotingBallot, type VotingOptionsConfig } from '@quiz/shared/voting';
import { VoteForm, type VoteFeedback } from '../../src/components/VoteForm';

const option = (optionId: string, label: string, help: string | null = null) => ({ optionId, label, help });
const small: VotingOptionsConfig = { schemaVersion: 1, prompt: 'Wähle genau eine Option.',
  options: [option('aa', 'Alpha', 'Kurze Hilfe'), option('bb', 'Beta'), option('cc', 'Gleich'), option('dd', 'Gleich')] };
const max: VotingOptionsConfig = { schemaVersion: 1, prompt: 'Eine Abstimmung mit der größten erlaubten Anzahl an Optionen und sehr langen Texten, die in schmalen Fenstern umbrechen müssen.',
  options: Array.from({ length: 32 }, (_, i) => option(`it${i}`, `Eine sehr lange Optionsbezeichnung, die in schmalen Fenstern mehrfach umbrechen muss (${i + 1})`,
    'Eine ebenso lange Hilfe, die umbricht und das Layout nicht sprengen darf, auch nicht bei 320 Pixeln Breite.')) };
const ALL = ['aa', 'bb', 'cc', 'dd'];
const fb = (over: Partial<VoteFeedback> & Pick<VoteFeedback, 'status'>): VoteFeedback => ({ contextKey: 'c', attemptId: null, ...over });
const noop = () => {};

declare global { interface Window { __submits: { case: string; ballot: VotingBallot }[] } }
window.__submits = [];
const record = (name: string) => (ballot: VotingBallot) => { window.__submits.push({ case: name, ballot }); };

function App() {
  return (
    <ThemeProvider>
      <main style={{ padding: 16, display: 'grid', gap: 32, maxWidth: 640 }}>
        <section data-case="default"><VoteForm title="Standardabstimmung" config={small} selectableOptionIds={ALL} allowAbstain={false} contextKey="c" onSubmit={record('default')} /></section>
        <section data-case="restricted"><VoteForm title="Eingeschränkte Auswahl" config={small} selectableOptionIds={['aa', 'cc']} allowAbstain={false} contextKey="c" onSubmit={record('restricted')} /></section>
        <section data-case="abstain"><VoteForm title="Mit Enthaltung" config={small} selectableOptionIds={ALL} allowAbstain contextKey="c" onSubmit={record('abstain')} /></section>
        <section data-case="max"><VoteForm title="Größte erlaubte Abstimmung mit langem Titel" config={max} selectableOptionIds={max.options.map(o => o.optionId)} allowAbstain contextKey="c" onSubmit={noop} /></section>
        <section data-case="error"><VoteForm title="Fehlerzustand" config={small} selectableOptionIds={ALL} allowAbstain={false} contextKey="c" onSubmit={noop} feedback={fb({ status: 'ERROR', retryable: true, message: 'Zu viele Anfragen. Bitte kurz warten und erneut senden.' })} /></section>
        <section data-case="fatal"><VoteForm title="Endgültiger Fehler" config={small} selectableOptionIds={ALL} allowAbstain={false} contextKey="c" onSubmit={noop} feedback={fb({ status: 'ERROR', retryable: false, message: 'Die Abstimmung ist nicht mehr offen.' })} /></section>
        <section data-case="pending"><VoteForm title="Wird gesendet" config={small} selectableOptionIds={ALL} allowAbstain={false} contextKey="c" onSubmit={noop} feedback={fb({ status: 'PENDING' })} /></section>
        <section data-case="confirmed"><VoteForm title="Bestätigt" config={small} selectableOptionIds={ALL} allowAbstain contextKey="c" onSubmit={noop} feedback={fb({ status: 'SUBMITTED', ballot: votingOptionBallot('cc') })} /></section>
        <section data-case="confirmed-abstain"><VoteForm title="Enthaltung bestätigt" config={small} selectableOptionIds={ALL} allowAbstain contextKey="c" onSubmit={noop} feedback={fb({ status: 'SUBMITTED', ballot: votingAbstainBallot() })} /></section>
        <section data-case="locked"><VoteForm title="Geschlossen" config={small} selectableOptionIds={ALL} allowAbstain contextKey="c" onSubmit={noop} feedback={fb({ status: 'LOCKED', ballot: votingOptionBallot('cc') })} /></section>
        <section data-case="locked-unconfirmed"><VoteForm title="Geschlossen ohne Stimme" config={small} selectableOptionIds={ALL} allowAbstain contextKey="c" onSubmit={noop} feedback={fb({ status: 'LOCKED' })} /></section>
      </main>
    </ThemeProvider>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
