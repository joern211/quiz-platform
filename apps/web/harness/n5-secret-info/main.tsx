// TEST-ONLY harness for the N5 SecretInfoCard with ARTIFICIAL data. Never served by the app: it lives outside src/ and
// index.html and is not part of any build. It is NOT an engine integration. Run: see docs/implementation/n5-secret-info-foundation/acceptance.md.
import React, { Profiler, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@quiz/ui';
import '@quiz/ui/styles/tokens.css';
import '../../src/index.css';
import { SECRET_INFO_CONTRACT, type SecretInfoExpectedContext, type SecretInfoFragmentView, type SecretInfoProjection } from '@quiz/shared/secretInfo';
import { SecretInfoCard } from '../../src/components/SecretInfoCard';

const CTX: SecretInfoExpectedContext = { runIndex: 1, roundId: 'round-1', dealId: 'deal-1', revision: 'rev-1', participantId: 'p1' };
const view = (title: string, text: string): SecretInfoFragmentView => ({ title, text });
const projection = (fragments: SecretInfoFragmentView[], ctx: SecretInfoExpectedContext = CTX): SecretInfoProjection => ({
  contract: SECRET_INFO_CONTRACT, scope: { runIndex: ctx.runIndex, roundId: ctx.roundId, dealId: ctx.dealId, revision: ctx.revision },
  own: { participantId: ctx.participantId, fragments }, released: [view('PUBLIC_MARK', 'PUBLIC_MARK')],
});

const longWord = 'Donaudampfschifffahrtsgesellschaftskapitänsmützenabzeichenhalterungsbeschreibung'.repeat(12).slice(0, 1000);
const twentyLines = Array.from({ length: 20 }, (_, i) => `Zeile ${i + 1}: kurzer Text, der umbrechen darf.`).join('\n');
const many = Array.from({ length: 8 }, (_, i) => view(`Eine sehr lange Überschrift für Information Nummer ${i + 1}, die auf kleinen Bildschirmen umbrechen muss`.slice(0, 80).trimEnd(), twentyLines));
const cases = {
  default: projection([view('DEFAULT_TITLE_A', 'DEFAULT_TEXT_A'), view('DEFAULT_TITLE_B', 'DEFAULT_TEXT_B')]),
  zero: projection([]),
  one: projection([view('ONE_TITLE', 'ONE_TEXT')]),
  long: projection([view('T'.repeat(80), longWord), ...many]),
  markup: projection([view('<b>MARKUP_TITLE</b>', '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>\nMARKUP_TEXT')]),
};

declare global { interface Window { __log: string[]; __xss?: number } }
window.__log = [];

/** Context switching with a late old payload, a withdrawal and a viewer-like projection — all with artificial data. */
function Switching() {
  const [ctx, setCtx] = useState<SecretInfoExpectedContext>(CTX);
  const [payload, setPayload] = useState<SecretInfoProjection | null>(projection([view('SWITCH_OLD', 'SWITCH_OLD_TEXT')], CTX));
  const next = { ...CTX, dealId: 'deal-2' };
  return (
    <section data-case="switch">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <button type="button" data-action="late" onClick={() => setCtx(next)}>Kontext wechselt, alte Projektion bleibt</button>
        <button type="button" data-action="fresh" onClick={() => setPayload(projection([view('SWITCH_NEW', 'SWITCH_NEW_TEXT')], next))}>Neue Projektion trifft ein</button>
        <button type="button" data-action="back" onClick={() => { setCtx(CTX); setPayload(projection([view('SWITCH_OLD', 'SWITCH_OLD_TEXT')], CTX)); }}>Zurück zum ersten Kontext</button>
        <button type="button" data-action="withdraw" onClick={() => setPayload(null)}>Entziehen</button>
        <button type="button" data-action="viewer" onClick={() => setPayload({ ...projection([], ctx), own: null })}>Viewer-Sicht</button>
        <button type="button" data-action="regain" onClick={() => setPayload(projection([view('SWITCH_OLD', 'SWITCH_OLD_TEXT')], CTX))}>Wieder erhalten</button>
      </div>
      <Profiler id="switch" onRender={() => { window.__log.push(document.querySelector('[data-case=switch]')?.textContent ?? ''); }}>
        <SecretInfoCard expected={ctx} projection={payload} title="Wechselnder Kontext" />
      </Profiler>
    </section>
  );
}

function App() {
  return (
    <ThemeProvider>
      <main style={{ padding: 16, display: 'grid', gap: 32, maxWidth: 640 }}>
        <section data-case="default"><SecretInfoCard expected={CTX} projection={cases.default} /></section>
        <section data-case="zero"><SecretInfoCard expected={CTX} projection={cases.zero} title="Null Fragmente" /></section>
        <section data-case="one"><SecretInfoCard expected={CTX} projection={cases.one} title="Ein Fragment" /></section>
        <section data-case="long"><SecretInfoCard expected={CTX} projection={cases.long} title="Sehr lange Inhalte und eine ebenfalls lange Überschrift der Karte" /></section>
        <section data-case="markup"><SecretInfoCard expected={CTX} projection={cases.markup} title="Markup bleibt Text" /></section>
        <section data-case="viewer"><SecretInfoCard expected={CTX} projection={{ ...cases.default, own: null }} title="Viewer-Sicht" /></section>
        <Switching />
      </main>
    </ThemeProvider>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
