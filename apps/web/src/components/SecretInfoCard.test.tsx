import { Profiler, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme, ACCENTS } from '@quiz/ui';
import { SECRET_INFO_CONTRACT, type SecretInfoExpectedContext, type SecretInfoFragmentView, type SecretInfoProjection } from '@quiz/shared/secretInfo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretInfoCard } from './SecretInfoCard';

afterEach(() => { cleanup(); vi.useRealTimers(); });

// Synthetic fixture: markers instead of game content; nothing here names a role or a rule.
const CTX: SecretInfoExpectedContext = { runIndex: 2, roundId: 'round-7', dealId: 'deal-1', revision: 'rev-1', participantId: 'p1' };
const view = (mark: string): SecretInfoFragmentView => ({ title: `TITLE_${mark}`, text: `TEXT_${mark}` });
const projection = (fragments: SecretInfoFragmentView[], ctx: SecretInfoExpectedContext = CTX, released: SecretInfoFragmentView[] = []): SecretInfoProjection => ({
  contract: SECRET_INFO_CONTRACT, scope: { runIndex: ctx.runIndex, roundId: ctx.roundId, dealId: ctx.dealId, revision: ctx.revision },
  own: { participantId: ctx.participantId, fragments }, released,
});
const toggle = () => screen.getByRole('button', { name: /^(Anzeigen|Verbergen)/ });
const body = () => document.body.innerHTML;
const normalized = (html: string) => html.replace(/:r[0-9a-z]+:/g, ':rX:'); // useId values differ per instance
function mount(over: { expected?: SecretInfoExpectedContext; projection?: SecretInfoProjection | null; title?: string } = {}) {
  const base = { expected: CTX, projection: projection([view('ALPHA'), view('DELTA')]) as SecretInfoProjection | null, ...over };
  const view_ = render(<SecretInfoCard {...base} />);
  return { view: view_, set: (next: typeof over) => view_.rerender(<SecretInfoCard {...base} {...next} />) };
}

describe('N5 SecretInfoCard: hidden by default, deliberate disclosure', () => {
  it('starts collapsed: neutral label, a native button, and NO fragment text anywhere in the DOM or its attributes', () => {
    const { view: v } = mount();
    expect(screen.getByRole('heading', { name: 'Geheime Informationen' })).toBeInTheDocument();
    expect(toggle().tagName).toBe('BUTTON');
    expect(toggle()).toHaveAttribute('type', 'button');
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(toggle()).toHaveTextContent('Anzeigen');
    const html = v.container.innerHTML + body();
    expect(html).not.toMatch(/TEXT_|TITLE_|ALPHA|DELTA/);
    for (const element of Array.from(document.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) expect(attribute.value, `${element.tagName}.${attribute.name}`).not.toMatch(/ALPHA|DELTA/);
    }
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(document.querySelectorAll('form')).toHaveLength(0); // an information card is not a submit form
  });
  it('looks identical collapsed for zero, one and many fragments — the label reveals nothing about the amount', () => {
    const shapes = [[], [view('ALPHA')], [view('ALPHA'), view('BRAVO'), view('CHARLIE'), view('DELTA')]];
    const htmls = shapes.map(fragments => { const { view: v } = mount({ projection: projection(fragments) }); const html = normalized(v.container.innerHTML); cleanup(); return html; });
    expect(htmls[1]).toBe(htmls[0]);
    expect(htmls[2]).toBe(htmls[0]);
  });
  it('wires aria-expanded / aria-controls to an existing panel that is empty while hidden', () => {
    mount();
    const panelId = toggle().getAttribute('aria-controls')!;
    const panel = document.getElementById(panelId);
    expect(panel).not.toBeNull();
    expect(panel!.childElementCount).toBe(0);
    expect(panel!.textContent).toBe('');
    expect(screen.getByRole('region', { name: 'Geheime Informationen' })).toBeInTheDocument();
  });
  it('shows and hides by mouse and removes the text from the DOM again', async () => {
    mount();
    await userEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(toggle()).toHaveTextContent('Verbergen');
    expect(screen.getByText('TITLE_ALPHA')).toBeInTheDocument();
    expect(screen.getByText('TEXT_DELTA')).toBeInTheDocument();
    expect(document.getElementById(toggle().getAttribute('aria-controls')!)).toContainElement(screen.getByText('TEXT_ALPHA'));
    await userEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(body()).not.toMatch(/TEXT_|TITLE_/);
  });
  it('shows and hides by keyboard (Tab, Enter, Space) and keeps the focus on the button', async () => {
    mount();
    await userEvent.tab();
    expect(toggle()).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(toggle()).toHaveFocus();
    expect(screen.getByText('TEXT_ALPHA')).toBeInTheDocument();
    await userEvent.keyboard(' ');
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(toggle()).toHaveFocus();
    expect(body()).not.toMatch(/TEXT_/);
  });
  it('renders the zero-fragment state neutrally behind the same toggle, without any role wording', async () => {
    mount({ projection: projection([]) });
    expect(body()).not.toMatch(/keine Informationen/); // even "nothing for you" stays hidden until opened
    await userEvent.click(toggle());
    expect(screen.getByText('Für dich liegen aktuell keine Informationen vor.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Rolle|Agent|Undercover|Saboteur|Imposter/i);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
  it('lists one and several fragments in the given order, title and text only', async () => {
    mount({ projection: projection([view('ALPHA')]) });
    await userEvent.click(toggle());
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    cleanup();
    mount({ projection: projection([view('ALPHA'), view('BRAVO'), view('CHARLIE')]) });
    await userEvent.click(toggle());
    const items = screen.getAllByRole('listitem');
    expect(items.map(item => item.textContent)).toEqual(['TITLE_ALPHATEXT_ALPHA', 'TITLE_BRAVOTEXT_BRAVO', 'TITLE_CHARLIETEXT_CHARLIE']);
    expect(screen.getAllByRole('heading', { level: 4 }).map(h => h.textContent)).toEqual(['TITLE_ALPHA', 'TITLE_BRAVO', 'TITLE_CHARLIE']);
  });
  it('never shows the public part of the projection: the card is for the own fragments only', async () => {
    mount({ projection: projection([view('ALPHA')], CTX, [view('PUBLIC')]) });
    await userEvent.click(toggle());
    expect(body()).toMatch(/TEXT_ALPHA/);
    expect(body()).not.toMatch(/PUBLIC/);
  });
  it('renders plain text only: markup, entities and links stay literal; line breaks are kept', async () => {
    const hostile = [
      { title: '<b>fett</b>', text: '<img src=x onerror="alert(1)"><script>alert(2)</script>' },
      { title: '&amp; &lt;', text: 'javascript:alert(3)\nhttps://example.test/<a href="x">y</a>' },
    ];
    mount({ projection: projection(hostile) });
    await userEvent.click(toggle());
    const panel = document.getElementById(toggle().getAttribute('aria-controls')!)!;
    expect(panel.querySelectorAll('img, script, a, b, iframe, svg, style')).toHaveLength(0);
    expect(panel.textContent).toContain('<img src=x onerror="alert(1)"><script>alert(2)</script>');
    expect(panel.textContent).toContain('&amp; &lt;');
    expect(screen.getByText(/^javascript:alert\(3\)/).textContent).toBe('javascript:alert(3)\nhttps://example.test/<a href="x">y</a>');
    expect(screen.getByText(/^javascript:alert\(3\)/).className).toMatch(/fragmentText/); // pre-wrap class keeps the line break
  });
  it('handles very long words and many lines without breaking structure (layout itself is checked in the browser harness)', async () => {
    const long = 'W'.repeat(1000);
    const lines = Array.from({ length: 20 }, (_, i) => `Zeile ${i + 1}`).join('\n');
    mount({ projection: projection([{ title: 'T'.repeat(80), text: long }, { title: 'Mehrzeilig', text: lines }]) });
    await userEvent.click(toggle());
    expect(screen.getByText(long)).toBeInTheDocument();
    expect(screen.getByText(/^Zeile 1\nZeile 2/, { normalizer: text => text })).toBeInTheDocument(); // line breaks survive (default matching would collapse them)
  });
  it('is no live region and uses no timer: nothing is announced or hidden automatically', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await userEvent.click(toggle());
    expect(document.querySelectorAll('[aria-live], [role=status], [role=alert], [role=log]')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { vi.advanceTimersByTime(10 * 60 * 1000); });
    expect(toggle()).toHaveAttribute('aria-expanded', 'true'); // no auto-hide either
  });
});

describe('N5 SecretInfoCard: binding to the expected context happens BEFORE rendering', () => {
  const others: [string, SecretInfoExpectedContext][] = [
    ['another run', { ...CTX, runIndex: 3 }], ['another round', { ...CTX, roundId: 'round-8' }], ['another deal', { ...CTX, dealId: 'deal-2' }],
    ['another revision', { ...CTX, revision: 'rev-2' }], ['another recipient', { ...CTX, participantId: 'p2' }],
  ];
  it('renders no text of a foreign or stale projection in the very first render (static markup, no effect can help)', () => {
    for (const [name, wrong] of others) {
      const html = renderToStaticMarkup(<SecretInfoCard expected={wrong} projection={projection([view('ALPHA')])} />);
      expect(html, name).not.toMatch(/ALPHA|TEXT_|TITLE_|Anzeigen/);
      expect(html, name).toContain('Zurzeit sind für dich keine Informationen verfügbar.');
    }
    expect(renderToStaticMarkup(<SecretInfoCard expected={CTX} projection={projection([view('ALPHA')])} />)).not.toMatch(/ALPHA/); // matching, but still hidden
  });
  it('rejects an invalid, over-complete or foreign-shaped projection as a whole', () => {
    const good = projection([view('ALPHA')]);
    const bad: unknown[] = [
      { ...good, role: 'rolemarker' }, { ...good, own: { ...good.own, roleId: 'rolemarker' } }, { ...good, own: { ...good.own!, fragments: [{ ...view('ALPHA'), fragmentId: 'frag' }] } },
      { ...good, contract: 'SECRET_INFO_V2' }, { ...good, scope: { ...good.scope, extra: 1 } }, { ...good, own: { participantId: 'p1' } },
      { ...good, own: { ...good.own!, fragments: [{ title: '', text: 'x' }] } }, { assignments: [{ participantId: 'p1', roleId: 'rolemarkerzulu' }], fragments: [view('ALPHA')] },
      { kind: 'SECRET_ROLE_DEAL', schemaVersion: 1, participantIds: ['p1'] }, 'TEXT_ALPHA', 42, [], {},
    ];
    for (const input of bad) {
      const html = renderToStaticMarkup(<SecretInfoCard expected={CTX} projection={input as never} />);
      expect(html, JSON.stringify(input)).not.toMatch(/ALPHA|rolemarker|TEXT_|Anzeigen/);
      expect(html).toContain('Zurzeit sind für dich keine Informationen verfügbar.');
    }
  });
  it('gives a viewer / display / host projection (no private part) no card content', () => {
    for (const own of [null]) {
      const html = renderToStaticMarkup(<SecretInfoCard expected={CTX} projection={{ ...projection([]), own, released: [view('PUBLIC')] }} />);
      expect(html).not.toMatch(/PUBLIC|Anzeigen/);
    }
    mount({ projection: null });
    expect(screen.getByText('Zurzeit sind für dich keine Informationen verfügbar.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('never shows an old payload in a new context — recorded at EVERY commit, including a late payload of the previous context', async () => {
    const commits: string[] = [];
    const record = () => { commits.push(document.body.textContent ?? ''); };
    const A = CTX, B = { ...CTX, dealId: 'deal-2' };
    const projA = projection([view('ALPHA')], A), projB = projection([view('BRAVO')], B);
    const App = ({ expected, p }: { expected: SecretInfoExpectedContext; p: SecretInfoProjection | null }) => (
      <Profiler id="card" onRender={record}><SecretInfoCard expected={expected} projection={p} /></Profiler>
    );
    const { rerender } = render(<App expected={A} p={projA} />);
    await userEvent.click(toggle());
    expect(body()).toMatch(/TEXT_ALPHA/);
    const afterOpen = commits.length;
    rerender(<App expected={B} p={projA} />); // the context changed, the payload of A is still the one in hand (late / stale)
    expect(body()).not.toMatch(/ALPHA/);
    rerender(<App expected={B} p={projB} />); // the payload of B arrives: hidden, not inherited as "open"
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(body()).not.toMatch(/ALPHA|BRAVO/);
    expect(commits.slice(afterOpen).some(text => /ALPHA/.test(text))).toBe(false); // not in ANY commit after the switch
    await userEvent.click(toggle());
    expect(body()).toMatch(/TEXT_BRAVO/);
    const afterOpenB = commits.length;
    rerender(<App expected={A} p={projB} />); // back to A with B's payload in hand
    expect(body()).not.toMatch(/BRAVO/);
    expect(commits.slice(afterOpenB).some(text => /BRAVO/.test(text))).toBe(false);
  });
  it('starts hidden again after every real context change — run, round, deal, revision, recipient — and never resurrects an old "open"', async () => {
    for (const [name, next] of others) {
      cleanup();
      const { set } = mount();
      await userEvent.click(toggle());
      expect(toggle()).toHaveAttribute('aria-expanded', 'true');
      set({ expected: next, projection: projection([view('ALPHA'), view('DELTA')], next) });
      expect(toggle(), name).toHaveAttribute('aria-expanded', 'false');
      expect(body(), name).not.toMatch(/TEXT_/);
      set({ expected: CTX, projection: projection([view('ALPHA'), view('DELTA')], CTX) }); // back to the first context
      expect(toggle(), `${name} (back)`).toHaveAttribute('aria-expanded', 'false');
      expect(body(), `${name} (back)`).not.toMatch(/TEXT_/);
    }
  });
  it('shows nothing of a withdrawn projection and starts hidden when it is received again', async () => {
    const { set } = mount();
    await userEvent.click(toggle());
    expect(body()).toMatch(/TEXT_ALPHA/);
    set({ projection: null }); // right withdrawn / caller switched to a viewer or display context
    expect(body()).not.toMatch(/ALPHA|DELTA/);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    set({ projection: projection([view('ALPHA'), view('DELTA')]) });
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(body()).not.toMatch(/TEXT_/);
    set({ projection: { ...projection([]), own: null, released: [view('PUBLIC')] } }); // switch to an unauthorised (viewer-like) projection
    expect(body()).not.toMatch(/ALPHA|PUBLIC/);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('starts hidden again if the delivered content under the same context changes (never a stale "open" over new text)', async () => {
    const { set } = mount();
    await userEvent.click(toggle());
    set({ projection: projection([view('ALPHA'), view('ECHO')]) });
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(body()).not.toMatch(/ECHO/);
  });
});

describe('N5 SecretInfoCard: stability across re-renders and theme', () => {
  it('keeps a valid open view across parent re-renders with a new but equal props wrapper', async () => {
    const { set } = mount();
    await userEvent.click(toggle());
    const node = toggle();
    set({ expected: { ...CTX }, projection: JSON.parse(JSON.stringify(projection([view('ALPHA'), view('DELTA')]))) as SecretInfoProjection });
    set({ title: 'Geheime Informationen' });
    expect(toggle()).toBe(node);
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('TEXT_ALPHA')).toBeInTheDocument();
  });
  it('keeps a hidden view hidden across re-renders as well', () => {
    const { set } = mount();
    set({ expected: { ...CTX }, projection: JSON.parse(JSON.stringify(projection([view('ALPHA'), view('DELTA')]))) as SecretInfoProjection });
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(body()).not.toMatch(/TEXT_/);
  });
  function Themed() {
    const { setTheme, setAccent } = useTheme();
    const [tick, setTick] = useState(0);
    return (
      <>
        <button type="button" onClick={() => setTheme('light')}>hell</button>
        <button type="button" onClick={() => setTheme('dark')}>dunkel</button>
        <button type="button" onClick={() => setAccent(ACCENTS[3].id)}>akzent</button>
        <button type="button" onClick={() => setTick(t => t + 1)}>neu</button>
        <SecretInfoCard key="same" expected={{ ...CTX }} projection={JSON.parse(JSON.stringify(projection([view('ALPHA')]))) as SecretInfoProjection} title={tick >= 0 ? 'Geheime Informationen' : ''} />
      </>
    );
  }
  it('keeps node identity and the open state across theme, accent and a forced parent re-render', async () => {
    render(<ThemeProvider><Themed /></ThemeProvider>);
    await userEvent.click(toggle());
    const node = toggle();
    for (const name of ['hell', 'akzent', 'dunkel', 'neu']) await act(async () => { screen.getByRole('button', { name }).click(); });
    expect(document.documentElement.dataset.accent).toBe(ACCENTS[3].id);
    expect(toggle()).toBe(node);
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('TEXT_ALPHA')).toBeInTheDocument();
  });
});

describe('N5 SecretInfoCard: no protocol of its own', () => {
  it('takes no callback and sends nothing: only the projection and the expected context, one button, no form', async () => {
    const { view: v } = mount();
    await userEvent.click(toggle());
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(v.container.querySelectorAll('form, input, textarea, select')).toHaveLength(0);
    expect(SecretInfoCard.length).toBe(1); // a function component with a single props object
  });
});
