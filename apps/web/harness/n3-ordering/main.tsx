// TEST-ONLY harness for the N3 OrderingForm. Never served by the app: it lives outside src/ and index.html
// and is not part of any build. Run: see docs/implementation/n3-ordering-foundation/acceptance.md.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@quiz/ui';
import '@quiz/ui/styles/tokens.css';
import '../../src/index.css';
import type { OrderingConfig, OrderingValue } from '@quiz/shared/ordering';
import { OrderingForm, type OrderingFeedback } from '../../src/components/OrderingForm';

const item = (itemId: string, label: string, help: string | null = null) => ({ itemId, label, help });
const small: OrderingConfig = { schemaVersion: 1, prompt: 'Bringe die Einträge in deine Reihenfolge.', directionHint: 'Oben steht zuerst.',
  items: [item('aa', 'Alpha', 'Kurze Hilfe'), item('bb', 'Beta'), item('cc', 'Gleich'), item('dd', 'Gleich')] };
const max: OrderingConfig = { schemaVersion: 1, prompt: 'Eine Aufgabe mit der größten erlaubten Anzahl an Einträgen und sehr langen Texten, die in schmalen Fenstern umbrechen müssen.', directionHint: null,
  items: Array.from({ length: 12 }, (_, i) => item(`it${i}`, `Ein sehr langer Eintragstitel, der in schmalen Fenstern mehrfach umbrechen muss (${i + 1})`,
    'Eine ebenso lange Hilfe, die umbricht und das Layout nicht sprengen darf, auch nicht bei 320 Pixeln Breite.')) };
const confirmed: OrderingValue = { schemaVersion: 1, itemIds: ['cc', 'aa', 'dd', 'bb'] };
const fb = (over: Partial<OrderingFeedback> & Pick<OrderingFeedback, 'status'>): OrderingFeedback => ({ contextKey: 'c', attemptId: null, ...over });
const noop = () => {};

declare global { interface Window { __submits: OrderingValue[] } }
window.__submits = [];

function App() {
  return (
    <ThemeProvider>
      <main style={{ padding: 16, display: 'grid', gap: 32, maxWidth: 640 }}>
        <section data-case="default"><OrderingForm title="Standardliste" config={small} contextKey="c" onSubmit={order => { window.__submits.push(order); }} /></section>
        <section data-case="max"><OrderingForm title="Größte erlaubte Liste mit langem Titel" config={max} contextKey="c" onSubmit={noop} /></section>
        <section data-case="error"><OrderingForm title="Fehlerzustand" config={small} contextKey="c" onSubmit={noop} feedback={fb({ status: 'ERROR', retryable: true, message: 'Zu viele Anfragen. Bitte kurz warten und erneut senden.' })} /></section>
        <section data-case="pending"><OrderingForm title="Wird gesendet" config={small} contextKey="c" onSubmit={noop} feedback={fb({ status: 'PENDING' })} /></section>
        <section data-case="confirmed"><OrderingForm title="Bestätigt" config={small} contextKey="c" onSubmit={noop} feedback={fb({ status: 'SUBMITTED', order: confirmed })} /></section>
        <section data-case="locked"><OrderingForm title="Gesperrt" config={small} contextKey="c" onSubmit={noop} feedback={fb({ status: 'LOCKED', order: confirmed })} /></section>
      </main>
    </ThemeProvider>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
