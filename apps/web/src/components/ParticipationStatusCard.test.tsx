import { Profiler, StrictMode, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme, ACCENTS } from '@quiz/ui';
import { PARTICIPATION_CONTRACT, type ParticipationActorView, type ParticipationExpectedContext, type ParticipationProjection } from '@quiz/shared/participation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ParticipationStatusCard } from './ParticipationStatusCard';

afterEach(() => { cleanup(); vi.useRealTimers(); });

// Synthetic fixture: markers instead of game content. Life values 777 / 555 are recognisable and never a rule.
const SCOPE = { runIndex: 2, trackId: 'track-1', rosterRevision: 'roster-1', actorKind: 'PARTICIPANT' as const };
const EXPECTED: ParticipationExpectedContext = { ...SCOPE, actorId: 'p1', minStateVersion: 3 };
const lives = (value: number | 'HIDDEN' | 'NO_MODEL'): ParticipationActorView['lives'] => (value === 'HIDDEN' ? { state: 'HIDDEN' } : value === 'NO_MODEL' ? { state: 'NO_MODEL' } : { state: 'VALUE', value });
const view = (actorId: string, status: 'ACTIVE' | 'ELIMINATED', value: number | 'HIDDEN' | 'NO_MODEL'): ParticipationActorView => ({ actorId, status, lives: lives(value) });
const projection = (own: ParticipationActorView | null, publicPart: ParticipationActorView[] = [], stateVersion = 5, scope = SCOPE): ParticipationProjection => ({
  contract: PARTICIPATION_CONTRACT, scope: { ...scope }, stateVersion, own, public: publicPart,
});
const body = () => document.body.innerHTML;
const text = () => document.body.textContent ?? '';
function mount(over: { expected?: ParticipationExpectedContext; projection?: ParticipationProjection | null; label?: string } = {}) {
  const base = { expected: EXPECTED, projection: projection(view('p1', 'ACTIVE', 777)) as ParticipationProjection | null, ...over };
  const rendered = render(<ParticipationStatusCard {...base} />);
  return { view: rendered, set: (next: typeof over) => rendered.rerender(<ParticipationStatusCard {...base} {...next} />) };
}

describe('N6 ParticipationStatusCard: status and lives', () => {
  it('shows an active and an eliminated actor unambiguously as text', () => {
    mount();
    expect(screen.getByText('Aktiv')).toBeInTheDocument();
    expect(screen.queryByText('Ausgeschieden')).not.toBeInTheDocument();
    cleanup();
    mount({ projection: projection(view('p1', 'ELIMINATED', 777)) });
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
    expect(screen.queryByText('Aktiv')).not.toBeInTheDocument();
  });
  it('keeps 0, a positive value, "no life model" and a hidden value apart — only a released number is ever a number', () => {
    mount({ projection: projection(view('p1', 'ACTIVE', 0)) });
    expect(screen.getByText('Leben')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument(); // 0 is a real value
    cleanup();
    mount({ projection: projection(view('p1', 'ACTIVE', 3)) });
    expect(screen.getByText('3')).toBeInTheDocument();
    cleanup();
    mount({ projection: projection(view('p1', 'ACTIVE', 'NO_MODEL')) }); // own record of a track without a life model
    expect(screen.queryByText('Leben')).not.toBeInTheDocument(); // no row, no "0", no empty bar
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByText('Aktiv')).toBeInTheDocument();
    cleanup();
    mount({ expected: { ...EXPECTED, actorId: 'p2' }, projection: projection(null, [view('p2', 'ACTIVE', 'HIDDEN')]) }); // a public entry with hidden lives
    expect(screen.queryByText('Leben')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByText('Aktiv')).toBeInTheDocument();
    cleanup();
  });
  it('does not derive the status from the lives: eliminated with remaining lives, active at 0 lives', () => {
    mount({ projection: projection(view('p1', 'ELIMINATED', 3)) });
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    cleanup();
    mount({ projection: projection(view('p1', 'ACTIVE', 0)) });
    expect(screen.getByText('Aktiv')).toBeInTheDocument(); // 0 lives and still active (a KEEP_ACTIVE policy of the server)
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.queryByText('Ausgeschieden')).not.toBeInTheDocument();
  });
  it('shows no life bar, no heart symbol, no KO marker, no winner, no points and no rank — also for the only remaining active actor', () => {
    mount({ expected: { ...EXPECTED, actorId: 'p2' }, projection: projection(null, [view('p1', 'ELIMINATED', 'HIDDEN'), view('p2', 'ACTIVE', 'HIDDEN'), view('p3', 'ELIMINATED', 'HIDDEN')]) });
    expect(screen.getByText('Aktiv')).toBeInTheDocument();
    expect(text()).not.toMatch(/Gewonn|Sieg|Gewinn|Platz|Rang|Punkte|Letzter|KO|❤|♥|♡|💔/i);
    expect(document.querySelectorAll('meter, progress, [role=progressbar], svg, img')).toHaveLength(0);
  });
  it('tells whose record it is: the own one or an explicitly public one', () => {
    mount();
    expect(screen.getByText('Deine eigene Angabe.')).toBeInTheDocument();
    cleanup();
    mount({ expected: { ...EXPECTED, actorId: 'p2' }, projection: projection(view('p1', 'ACTIVE', 777), [view('p2', 'ELIMINATED', 'HIDDEN')]) });
    expect(screen.getByText('Öffentlich sichtbar.')).toBeInTheDocument();
  });
  it('renders the label as plain text and keeps long labels from breaking the structure', () => {
    mount({ label: '<b>Sehr</b> langer Name ' + 'W'.repeat(300) });
    expect(document.querySelectorAll('b')).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('<b>Sehr</b> langer Name ' + 'W'.repeat(300));
    expect(screen.getByRole('region', { name: /langer Name/ })).toBeInTheDocument();
  });
  it('is a pure display: no form, no control, no callback, no timer, no live region, no tooltip', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { view: v } = mount();
    expect(v.container.querySelectorAll('form, input, button, select, textarea, a, [role=button]')).toHaveLength(0);
    expect(document.querySelectorAll('[aria-live], [role=status], [role=alert], [role=log], [title]')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(ParticipationStatusCard.length).toBe(1); // one props object, no callbacks among them
  });
});

describe('N6 ParticipationStatusCard: private data stays out of the DOM unless released', () => {
  it('never renders another record of the projection — the own lives 777 of p1 are not shown for the public actor p2', () => {
    mount({ expected: { ...EXPECTED, actorId: 'p2' }, projection: projection(view('p1', 'ACTIVE', 777), [view('p1', 'ACTIVE', 'HIDDEN'), view('p2', 'ELIMINATED', 'HIDDEN')]) });
    expect(body()).not.toMatch(/777/);
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
    for (const element of Array.from(document.querySelectorAll('*'))) for (const attribute of Array.from(element.attributes)) expect(attribute.value, `${element.tagName}.${attribute.name}`).not.toMatch(/777|p1|p2/);
  });
  it('shows a hidden or unreleased value nowhere, also not in attributes', () => {
    mount({ expected: { ...EXPECTED, actorId: 'p2' }, projection: projection(null, [view('p2', 'ACTIVE', 'HIDDEN')]) });
    expect(body()).not.toMatch(/HIDDEN|NO_MODEL|\bVALUE\b|maxLives|zeroLivesPolicy/); // case-sensitive: the CSS class "value" is no leak
    for (const element of Array.from(document.querySelectorAll('*'))) for (const attribute of Array.from(element.attributes)) expect(attribute.value).not.toMatch(/HIDDEN|ACTIVE|ELIMINATED|p2/);
  });
  it('keeps the unavailable state free of any actor data and of any hint about what exists', () => {
    mount({ projection: null });
    expect(screen.getByText('Der Status ist zurzeit nicht verfügbar.')).toBeInTheDocument();
    expect(text()).not.toMatch(/Aktiv|Ausgeschieden|Leben|\d/);
  });
});

describe('N6 ParticipationStatusCard: binding to the expected context happens BEFORE rendering', () => {
  const wrongs: [string, ParticipationExpectedContext][] = [
    ['another run', { ...EXPECTED, runIndex: 3 }], ['another track', { ...EXPECTED, trackId: 'track-2' }], ['another roster revision', { ...EXPECTED, rosterRevision: 'roster-2' }],
    ['another actor kind', { ...EXPECTED, actorKind: 'TEAM' }], ['another actor', { ...EXPECTED, actorId: 'p9' }], ['a newer snapshot expected', { ...EXPECTED, minStateVersion: 6 }],
  ];
  it('renders nothing of a foreign or stale projection in the very first render (static markup, no effect can help)', () => {
    for (const [name, wrong] of wrongs) {
      const html = renderToStaticMarkup(<ParticipationStatusCard expected={wrong} projection={projection(view('p1', 'ACTIVE', 777))} />);
      expect(html, name).not.toMatch(/Aktiv|Ausgeschieden|777|Leben/);
      expect(html, name).toContain('Der Status ist zurzeit nicht verfügbar.');
    }
    expect(renderToStaticMarkup(<ParticipationStatusCard expected={EXPECTED} projection={projection(view('p1', 'ACTIVE', 777))} />)).toContain('Aktiv'); // the matching one is shown
  });
  it('rejects an invalid, over-complete or foreign-shaped projection as a whole', () => {
    const good = projection(view('p1', 'ACTIVE', 777));
    const bad: unknown[] = [
      { ...good, maxLives: 3 }, { ...good, own: { ...good.own, cause: 'EXPLICIT' } }, { ...good, scope: { ...good.scope, extra: 1 } }, { ...good, contract: 'PARTICIPATION_STATUS_V2' },
      { ...good, own: { actorId: 'p1', status: 'DEAD', lives: lives(3) } }, { ...good, own: { actorId: 'p1', status: 'ACTIVE', lives: { state: 'VALUE', value: -1 } } },
      { ...good, own: { actorId: 'p1', status: 'ACTIVE', lives: { state: 'VALUE', value: 1.5 } } }, { ...good, stateVersion: -1 }, { ...good, stateVersion: '5' },
      { kind: 'PARTICIPATION_TRACK', schemaVersion: 1, actors: [{ actorId: 'p1', status: 'ACTIVE', lives: 777, elimination: null }], config: { livesMode: 'ON', maxLives: 999 } }, 'ACTIVE', 7, [], {},
    ];
    for (const input of bad) {
      const html = renderToStaticMarkup(<ParticipationStatusCard expected={EXPECTED} projection={input as never} />);
      expect(html, JSON.stringify(input)).not.toMatch(/Aktiv|Ausgeschieden|777|Leben/);
      expect(html).toContain('Der Status ist zurzeit nicht verfügbar.');
    }
  });
  it('shows nothing for a viewer-like projection that holds no record of the actor, and for an unreleased public part', () => {
    mount({ projection: projection(null, []) });
    expect(screen.getByText('Der Status ist zurzeit nicht verfügbar.')).toBeInTheDocument();
    cleanup();
    mount({ projection: projection(null, [view('p9', 'ACTIVE', 'HIDDEN')]) });
    expect(screen.getByText('Der Status ist zurzeit nicht verfügbar.')).toBeInTheDocument();
  });
  it('never shows an old payload in a new context — recorded at EVERY commit, including a late payload of the previous context', () => {
    const commits: string[] = [];
    const A = EXPECTED, B = { ...EXPECTED, runIndex: 3 };
    const projA = projection(view('p1', 'ELIMINATED', 777)), projB = projection(view('p1', 'ACTIVE', 555), [], 5, { ...SCOPE, runIndex: 3 });
    const App = ({ expected, p }: { expected: ParticipationExpectedContext; p: ParticipationProjection | null }) => (
      <Profiler id="card" onRender={() => { commits.push(document.body.textContent ?? ''); }}><ParticipationStatusCard expected={expected} projection={p} /></Profiler>
    );
    const { rerender } = render(<App expected={A} p={projA} />);
    expect(text()).toMatch(/Ausgeschieden/);
    const after = commits.length;
    rerender(<App expected={B} p={projA} />); // the context changed, the payload of A is still the one in hand (late)
    expect(text()).not.toMatch(/Ausgeschieden|777/);
    rerender(<App expected={B} p={projB} />);
    expect(text()).toMatch(/Aktiv/);
    expect(text()).toMatch(/555/);
    expect(commits.slice(after).some(c => /Ausgeschieden|777/.test(c))).toBe(false); // not in ANY commit after the switch
    const afterB = commits.length;
    rerender(<App expected={A} p={projB} />); // back to A with B's payload in hand
    expect(text()).not.toMatch(/Aktiv|555/);
    expect(commits.slice(afterB).some(c => /Aktiv|555/.test(c))).toBe(false);
  });
  it('shows the actor that is expected: switching to another actor of the same projection never shows the first one\'s values', () => {
    const p = projection(view('p1', 'ACTIVE', 777), [view('p1', 'ACTIVE', 'HIDDEN'), view('p2', 'ELIMINATED', 'HIDDEN')]);
    const { set } = mount({ projection: p });
    expect(text()).toMatch(/777/);
    set({ expected: { ...EXPECTED, actorId: 'p2' } });
    expect(text()).not.toMatch(/777/);
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
    set({ expected: EXPECTED });
    expect(text()).toMatch(/777/); // the own record of p1 is shown again from the CURRENT projection
  });
});

describe('N6 ParticipationStatusCard: snapshot order — a late old snapshot never revives', () => {
  it('keeps "Ausgeschieden" and the lower lives when an OLDER snapshot (still above the expected minimum) arrives later — in no commit is it "Aktiv" again', () => {
    const commits: string[] = [];
    const App = ({ p }: { p: ParticipationProjection }) => <Profiler id="card" onRender={() => { commits.push(document.body.textContent ?? ''); }}><ParticipationStatusCard expected={EXPECTED} projection={p} /></Profiler>;
    const v4 = projection(view('p1', 'ACTIVE', 2), [], 4), v6 = projection(view('p1', 'ELIMINATED', 0), [], 6);
    const { rerender } = render(<App p={v4} />);
    expect(text()).toMatch(/Aktiv/);
    expect(text()).toMatch(/2/);
    rerender(<App p={v6} />);
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    const mark = commits.length;
    rerender(<App p={v4} />); // the old snapshot arrives late
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(text()).not.toMatch(/Aktiv|\b2\b/);
    expect(commits.slice(mark).some(c => /Aktiv/.test(c))).toBe(false);
    rerender(<App p={projection(view('p1', 'ELIMINATED', 0), [], 6)} />); // an equal newer-or-same snapshot is fine
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
  });
  it('rejects a projection older than the independently expected snapshot — and accepts it again once the expected stand allows it', () => {
    const v5 = projection(view('p1', 'ELIMINATED', 0), [], 5);
    const { set } = mount({ projection: v5, expected: { ...EXPECTED, minStateVersion: 5 } });
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
    set({ expected: { ...EXPECTED, minStateVersion: 7 } }); // the caller already knows snapshot 7: snapshot 5 is stale
    expect(screen.getByText('Der Status ist zurzeit nicht verfügbar.')).toBeInTheDocument();
    expect(text()).not.toMatch(/Ausgeschieden|Aktiv/);
    set({ projection: projection(view('p1', 'ELIMINATED', 0), [], 7), expected: { ...EXPECTED, minStateVersion: 7 } });
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
  });
  it('does not take the expected version from the incoming projection: a stale projection cannot vouch for itself', () => {
    const stale = projection(view('p1', 'ACTIVE', 3), [], 4);
    mount({ projection: stale, expected: { ...EXPECTED, minStateVersion: 9 } });
    expect(text()).not.toMatch(/Aktiv|3/);
    expect(screen.getByText('Der Status ist zurzeit nicht verfügbar.')).toBeInTheDocument();
  });
  it('does not substitute a different kind of record for a newer one: after a role change an older public entry shows nothing instead of the old private lives', () => {
    const own = projection(view('p1', 'ACTIVE', 777), [], 8);
    const { set } = mount({ projection: own });
    expect(text()).toMatch(/777/);
    set({ projection: projection(null, [view('p1', 'ACTIVE', 'HIDDEN')], 6) }); // an OLDER public projection of the same actor
    expect(text()).not.toMatch(/777|Aktiv/);
    expect(screen.getByText('Der Status ist zurzeit nicht verfügbar.')).toBeInTheDocument();
  });
  it('shows an equal-version projection with new content (same snapshot, replaced)', () => {
    const { set } = mount({ projection: projection(view('p1', 'ACTIVE', 3), [], 5) });
    set({ projection: projection(view('p1', 'ACTIVE', 2), [], 5) });
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});

describe('N6 ParticipationStatusCard: withdrawal, regain, role change', () => {
  it('discards everything on withdrawal but KEEPS the version knowledge: a late older package after the withdrawal neither revives "Aktiv" nor old lives; a real newer projection is shown again', () => {
    const { set } = mount({ projection: projection(view('p1', 'ELIMINATED', 777), [], 9) });
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
    set({ projection: null });
    expect(text()).not.toMatch(/Ausgeschieden|777/);
    set({ projection: projection(view('p1', 'ACTIVE', 555), [], 5) }); // older than the v9 already known in THIS context
    expect(screen.getByText('Der Status ist zurzeit nicht verfügbar.')).toBeInTheDocument();
    expect(text()).not.toMatch(/Aktiv|555|777|Ausgeschieden/);
    set({ projection: projection(view('p1', 'ACTIVE', 555), [], 10) }); // a real newer admissible projection works normally again
    expect(screen.getByText('Aktiv')).toBeInTheDocument();
    expect(screen.getByText('555')).toBeInTheDocument();
    expect(text()).not.toMatch(/777|Ausgeschieden/);
  });
  it('treats undefined like null: private data are gone at once and the version mark survives', () => {
    const { set } = mount({ projection: projection(view('p1', 'ELIMINATED', 777), [], 9) });
    set({ projection: undefined });
    expect(text()).not.toMatch(/Ausgeschieden|777/);
    expect(screen.getByText('Der Status ist zurzeit nicht verfügbar.')).toBeInTheDocument();
    set({ projection: projection(view('p1', 'ACTIVE', 3), [], 5) });
    expect(text()).not.toMatch(/Aktiv|3/);
    set({ projection: projection(view('p1', 'ACTIVE', 3), [], 9) }); // the same snapshot number is not older
    expect(screen.getByText('Aktiv')).toBeInTheDocument();
  });
  it('is not poisoned by invalid, foreign or below-minimum projections: their (even huge or tiny) version numbers move nothing', () => {
    const { set } = mount({ projection: projection(view('p1', 'ELIMINATED', 0), [], 9) });
    const base = projection(view('p1', 'ACTIVE', 3), [], 1000);
    set({ projection: { ...base, maxLives: 3 } as never }); // malformed (extra field) with a huge version
    expect(screen.getByText('Der Status ist zurzeit nicht verfügbar.')).toBeInTheDocument();
    set({ projection: projection(view('p1', 'ACTIVE', 3), [], 5000, { ...SCOPE, runIndex: 3 }) }); // another run, huge version
    expect(screen.getByText('Der Status ist zurzeit nicht verfügbar.')).toBeInTheDocument();
    set({ projection: projection(view('p1', 'ACTIVE', 3), [], 5000, { ...SCOPE, trackId: 'track-2' }) });
    set({ projection: { ...projection(view('p1', 'ACTIVE', 3), [], 5), contract: 'PARTICIPATION_STATUS_V2' } as never });
    set({ projection: projection(view('p1', 'ACTIVE', 3), [], 2) }); // valid scope but BELOW the caller's minimum 3: ignored, also does not lower the mark
    expect(screen.getByText('Der Status ist zurzeit nicht verfügbar.')).toBeInTheDocument();
    set({ projection: projection(view('p1', 'ACTIVE', 3), [], 6) }); // still older than the genuine v9: refused
    expect(text()).not.toMatch(/Aktiv|\b3\b/);
    set({ projection: projection(view('p1', 'ELIMINATED', 0), [], 10) }); // genuine newer: accepted although a poisoned 1000 / 5000 had been seen
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
  });
  it('counts a valid newer projection WITHOUT a record for the actor as an observation: the old private value does not come back from an older package', () => {
    const { set } = mount({ projection: projection(view('p1', 'ACTIVE', 777), [], 8) });
    expect(screen.getByText('777')).toBeInTheDocument();
    set({ projection: projection(null, [view('p2', 'ACTIVE', 'HIDDEN')], 10) }); // valid, matching, but no entry for p1
    expect(text()).not.toMatch(/777/);
    expect(screen.getByText('Der Status ist zurzeit nicht verfügbar.')).toBeInTheDocument();
    set({ projection: projection(view('p1', 'ACTIVE', 555), [], 9) });
    expect(text()).not.toMatch(/555|Deine eigene Angabe/);
    set({ projection: projection(view('p1', 'ACTIVE', 555), [], 11) }); // a real newer, admissible release is shown again
    expect(screen.getByText('555')).toBeInTheDocument();
    expect(screen.getByText('Deine eigene Angabe.')).toBeInTheDocument();
  });
  it('keeps refusing the same old package over repeated deliveries and parent re-renders with fresh wrapper objects — in no committed DOM state', () => {
    const commits: string[] = [];
    const App = ({ p, tick }: { p: ParticipationProjection | null; tick: number }) => (
      <StrictMode><Profiler id="card" onRender={() => { commits.push(document.body.textContent ?? ''); }}>
        <ParticipationStatusCard expected={{ ...EXPECTED }} projection={p} label={`Spielstatus ${tick}`} />
      </Profiler></StrictMode>
    );
    const { rerender } = render(<App p={projection(view('p1', 'ELIMINATED', 777), [], 9)} tick={0} />);
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
    rerender(<App p={null} tick={1} />);
    const mark = commits.length;
    for (let i = 2; i < 6; i++) {
      rerender(<App p={JSON.parse(JSON.stringify(projection(view('p1', 'ACTIVE', 555), [], 5))) as ParticipationProjection} tick={i} />);
      expect(text()).not.toMatch(/Aktiv|555/);
      rerender(<App p={null} tick={i} />);
    }
    expect(commits.slice(mark).some(c => /Aktiv|555|777|Ausgeschieden/.test(c))).toBe(false); // not in ANY commit after the withdrawal
    rerender(<App p={projection(view('p1', 'ELIMINATED', 777), [], 9)} tick={9} />); // an equal-version re-delivery of the legitimately known snapshot is fine
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
  });
  it('separates a real context change from a withdrawal: another actor / run starts with an empty mark and is not judged by the old context\'s version', () => {
    const { set } = mount({ projection: projection(view('p1', 'ELIMINATED', 0), [view('p2', 'ACTIVE', 'HIDDEN')], 9) });
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
    set({ expected: { ...EXPECTED, actorId: 'p2' }, projection: projection(null, [view('p2', 'ACTIVE', 'HIDDEN')], 4) }); // v4 < v9 of p1's context: p2 is another context
    expect(screen.getByText('Aktiv')).toBeInTheDocument();
    expect(text()).not.toMatch(/Ausgeschieden/);
    set({ expected: { ...EXPECTED, runIndex: 3 }, projection: projection(view('p1', 'ACTIVE', 3), [], 3, { ...SCOPE, runIndex: 3 }) });
    expect(screen.getByText('Aktiv')).toBeInTheDocument(); // another run: fresh, the old run's v9 does not apply
  });
  it('shows no private value after a switch to a viewer-like projection and again after regaining the private one', () => {
    const { set } = mount({ projection: projection(view('p1', 'ACTIVE', 777), [view('p1', 'ACTIVE', 'HIDDEN')], 9) });
    expect(text()).toMatch(/777/);
    set({ projection: projection(null, [view('p1', 'ACTIVE', 'HIDDEN')], 10) }); // a viewer-like projection with the status released but no own record
    expect(text()).not.toMatch(/777/);
    expect(screen.getByText('Öffentlich sichtbar.')).toBeInTheDocument();
    expect(screen.queryByText('Leben')).not.toBeInTheDocument();
    set({ projection: projection(null, [], 11) });
    expect(screen.getByText('Der Status ist zurzeit nicht verfügbar.')).toBeInTheDocument();
    set({ projection: projection(view('p1', 'ACTIVE', 3), [], 12) });
    expect(text()).toMatch(/3/);
    expect(text()).not.toMatch(/777/);
  });
});

describe('N6 ParticipationStatusCard: stability across re-renders and theme', () => {
  it('keeps a valid view and its DOM nodes across parent re-renders with a new but equal props wrapper', () => {
    const { set } = mount();
    const node = screen.getByText('Aktiv');
    set({ expected: { ...EXPECTED }, projection: JSON.parse(JSON.stringify(projection(view('p1', 'ACTIVE', 777)))) as ParticipationProjection });
    set({ label: 'Spielstatus' });
    expect(screen.getByText('Aktiv')).toBe(node);
    expect(screen.getByText('777')).toBeInTheDocument();
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
        <ParticipationStatusCard expected={{ ...EXPECTED }} projection={JSON.parse(JSON.stringify(projection(view('p1', 'ELIMINATED', 0)))) as ParticipationProjection} label={tick >= 0 ? 'Spielstatus' : ''} />
      </>
    );
  }
  it('keeps node identity and the shown status across theme, accent and a forced parent re-render', async () => {
    render(<ThemeProvider><Themed /></ThemeProvider>);
    const node = screen.getByText('Ausgeschieden');
    for (const name of ['hell', 'akzent', 'dunkel', 'neu']) await act(async () => { screen.getByRole('button', { name }).click(); });
    expect(document.documentElement.dataset.accent).toBe(ACCENTS[3].id);
    expect(screen.getByText('Ausgeschieden')).toBe(node);
    expect(screen.getByText('0')).toBeInTheDocument();
    await userEvent.tab(); // nothing in the card is focusable: the first focusable element is the test's own theme button
    expect(document.activeElement?.tagName).toBe('BUTTON');
    expect(document.activeElement?.textContent).toBe('hell');
  });
});
