// TEST-ONLY harness for the N2 TextCardForm. Never served by the app: it lives outside src/ and index.html
// and is not part of any build. Run: see README.md in docs/implementation/n2-multifield-foundation/.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@quiz/ui';
import '@quiz/ui/styles/tokens.css';
import '../../src/index.css';
import type { TextCardConfig, TextCardFeedback, TextCardValue } from '../../src/components/TextCardForm';
import { TextCardForm } from '../../src/components/TextCardForm';

type Config = import('@quiz/shared/textcard').TextCardConfig;
const field = (fieldId: string, label: string, help: string | null, required = false) => ({ fieldId, label, help, required });
const small: Config = { schemaVersion: 1, maxCodePointsPerField: 40, maxTotalCodePoints: 200,
  fields: [field('alpha', 'Erstes Feld', 'Kurze Hilfe', true), field('beta', 'Zweites Feld', null), field('gamma', 'Drittes Feld', 'Noch eine Hilfe')] };
const many: Config = { schemaVersion: 1, maxCodePointsPerField: 40, maxTotalCodePoints: 400,
  fields: Array.from({ length: 12 }, (_, i) => field(`f${i}`, `Ein sehr langer Feldtitel, der in schmalen Fenstern mehrfach umbrechen muss (${i + 1})`,
    'Eine ebenso lange Hilfe, die umbricht und das Layout nicht sprengen darf.', i === 0)) };
const confirmed: TextCardValue = { schemaVersion: 1, answers: [{ fieldId: 'alpha', value: 'Köln' }, { fieldId: 'beta', value: null }, { fieldId: 'gamma', value: 'Rhein 😀' }] };
const fb = (over: Partial<TextCardFeedback> & Pick<TextCardFeedback, 'status'>): TextCardFeedback => ({ contextKey: 'c', attemptId: null, ...over });
const noop = () => {};

function App() {
  return (
    <ThemeProvider>
      <main style={{ padding: 16, display: 'grid', gap: 32, maxWidth: 640 }}>
        <section data-case="default"><TextCardForm title="Standardkarte" config={small} contextKey="c" onSubmit={noop} /></section>
        <section data-case="many"><TextCardForm title="Eine Karte mit sehr vielen erlaubten Feldern und einem langen Titel" config={many} contextKey="c" onSubmit={noop} /></section>
        <section data-case="error"><TextCardForm title="Fehlerzustand" config={small} contextKey="c" onSubmit={noop}
          feedback={fb({ status: 'ERROR', retryable: true, message: 'Zu viele Anfragen. Bitte kurz warten und erneut senden.', fieldErrors: [{ fieldId: 'beta', code: 'TEXT_TOO_LONG' }] })} /></section>
        <section data-case="pending"><TextCardForm title="Wird gesendet" config={small} contextKey="c" onSubmit={noop} feedback={fb({ status: 'PENDING' })} /></section>
        <section data-case="confirmed"><TextCardForm title="Bestätigt" config={small} contextKey="c" onSubmit={noop} feedback={fb({ status: 'SUBMITTED', card: confirmed })} /></section>
        <section data-case="locked"><TextCardForm title="Gesperrt" config={small} contextKey="c" onSubmit={noop} feedback={fb({ status: 'LOCKED', card: confirmed })} /></section>
      </main>
    </ThemeProvider>
  );
}
export type { TextCardConfig };
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
