import { StrictMode, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ACCENTS, ThemeProvider, useTheme } from '@quiz/ui';
import { biddingActionBindingKey, type BiddingBidIntent, type BiddingExpectedContext, type BiddingPassIntent, type BiddingProjection } from '@quiz/shared/bidding';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BiddingPanel, type BiddingFeedback } from './BiddingPanel';
import { SCOPE, expectedFor, neutral, standing, type Stand } from '../bidding/biddingTestFixtures';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const NAMES = { T1: 'Team Eins', T2: 'Team Zwei', T3: 'Team Drei' };
const S1: Stand = { sv: 5, bv: 3, qv: 2, turn: 3 };
const text = () => document.body.textContent ?? '';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const deferred = () => { let resolve!: (v?: unknown) => void, reject!: (e?: unknown) => void; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

interface Mount { expected?: BiddingExpectedContext; projection?: BiddingProjection | null; names?: Record<string, string>; onBid?: (i: BiddingBidIntent) => void | Promise<unknown>; onPass?: (i: BiddingPassIntent) => void | Promise<unknown>; feedback?: BiddingFeedback | null }
function mount(over: Mount = {}) {
  const base = { expected: expectedFor('b1'), projection: standing(S1) as BiddingProjection | null, names: NAMES, ...over };
  if (over.expected === undefined && base.projection !== null && base.projection !== undefined) base.expected = expectedFor(base.projection.recipientId);
  const utils = render(<BiddingPanel {...base} />);
  return { ...utils, set: (next: Mount) => utils.rerender(<BiddingPanel {...base} {...next} />) };
}
const field = () => screen.queryByRole('textbox', { name: 'Dein Gebot' });
const bidButton = () => screen.queryByRole('button', { name: /^(Bieten|Wird gesendet)/ });
const passButton = () => screen.queryByRole('button', { name: /^(Passen|Gesendet)/ });
/** The origin an intent must carry for a fixture of stand `stand` and team `team` (target, team and the three counters). */
const origin = (stand: Stand, teamId = 'T1') => ({ scope: { ...SCOPE }, teamId, turnNumber: stand.turn, sequenceVersion: stand.qv, biddingVersion: stand.bv });

describe('N10 BiddingPanel: what is shown', () => {
  it('a pinned bidder on turn sees category, standing, teams in words (leader / left / still in), the field and the pass with its consequence', () => {
    mount({ projection: standing(S1, { leader: { teamId: 'T2', units: 5 }, passed: ['T3'] }), onBid: vi.fn(), onPass: vi.fn() });
    expect(text()).toContain('Kategorie: Hauptstädte');
    expect(screen.getByRole('status')).toHaveTextContent('Höchstgebot: 5 Städte von Team Zwei.');
    expect(screen.getByText('Du bist am Zug.')).toBeInTheDocument();
    const teams = screen.getAllByRole('listitem').map(li => li.textContent);
    expect(teams).toEqual(['Team Einsim Rennen', 'Team Zweiführt', 'Team Dreiausgestiegen']); // state as a word, not by colour or frame alone
    expect(field()).toBeInTheDocument();
    expect(screen.getByText(/Es muss höher sein als das Höchstgebot/)).toBeInTheDocument();
    expect(passButton()).toBeInTheDocument();
    expect(screen.getByText(/Du steigst aus diesem Bieten aus und kannst nicht wieder einsteigen/)).toBeInTheDocument();
  });
  it('before the first bid there is "Noch kein Gebot", the bid field and NO pass (a pass before the first bid does not exist)', () => {
    mount({ projection: standing(S1, { leader: null }), onBid: vi.fn(), onPass: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent('Noch kein Gebot.');
    expect(field()).toBeInTheDocument();
    expect(passButton()).not.toBeInTheDocument();
  });
  it('a waiting bidder (not on turn, leading, or left) sees the standing but no control; a missing callback hides the control too', () => {
    mount({ projection: standing(S1, { onTurn: 'T3' }), onBid: vi.fn(), onPass: vi.fn() });
    expect(screen.getByText('Ein anderes Team ist am Zug.')).toBeInTheDocument();
    expect(field()).not.toBeInTheDocument();
    expect(passButton()).not.toBeInTheDocument();
    cleanup();
    mount({ projection: standing(S1, { youTeam: 'T2', recipient: 'b2', onTurn: 'T3', leader: { teamId: 'T2', units: 5 } }), onBid: vi.fn(), onPass: vi.fn() });
    expect(screen.getByText('Du führst. Warte auf die anderen Teams.')).toBeInTheDocument();
    cleanup();
    mount({ projection: standing(S1, { youTeam: 'T3', recipient: 'b3', onTurn: 'T1', passed: ['T3'] }), onBid: vi.fn(), onPass: vi.fn() });
    expect(screen.getByText('Dein Team ist ausgestiegen.')).toBeInTheDocument();
    cleanup();
    mount({ projection: standing(S1) });
    expect(field()).not.toBeInTheDocument(); // no callback: no control
  });
  it('the minimum of the field is the smallest STRICTLY HIGHER value: equal or lower input is refused locally and nothing is sent', async () => {
    const user = userEvent.setup();
    const onBid = vi.fn();
    mount({ projection: standing(S1, { leader: { teamId: 'T2', units: 5 } }), onBid, onPass: vi.fn() });
    await user.type(field()!, '5');
    await user.click(bidButton()!);
    expect(onBid).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Die Zahl muss zwischen 6 und 999 liegen.');
    await user.clear(field()!);
    await user.type(field()!, '6');
    await user.click(bidButton()!);
    expect(onBid).toHaveBeenCalledTimes(1);
  });
  it('an open bidding in which nobody is up (HELD / schedule mismatch) says so in words and offers no control to anybody', () => {
    mount({ projection: standing(S1, { onTurn: null }), onBid: vi.fn(), onPass: vi.fn() });
    expect(screen.getByText('Im Moment kann niemand bieten.')).toBeInTheDocument();
    expect(field()).not.toBeInTheDocument();
    expect(passButton()).not.toBeInTheDocument();
    expect(screen.queryByText('Ein anderes Team ist am Zug.')).not.toBeInTheDocument();
  });
  it('the one-decimal profile: comma and point are decimal signs only, the minimum is one unit higher (0,3 → 0,4), an incomplete or too precise value is refused locally, nothing is rounded', async () => {
    const user = userEvent.setup();
    const onBid = vi.fn();
    const decimal = (stand: Stand): BiddingProjection => {
      const base = standing(stand, { leader: { teamId: 'T2', units: 3 } }) as Extract<BiddingProjection, { release: 'STANDING' }>;
      return { ...base, numeric: { ...base.numeric, scale: 1, bounds: { min: { units: 1, scale: 1 }, max: { units: 1000, scale: 1 } } }, standing: { teamId: 'T2', value: { units: 3, scale: 1 } } };
    };
    mount({ projection: decimal(S1), onBid, onPass: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent('Höchstgebot: 0,3 Städte von Team Zwei.');
    await user.type(field()!, '0,3'); await user.click(bidButton()!);
    expect(screen.getByRole('alert')).toHaveTextContent('Die Zahl muss zwischen 0,4 und 100,0 liegen.');
    await user.clear(field()!); await user.type(field()!, '0,'); await user.click(bidButton()!);
    expect(screen.getByRole('alert')).toHaveTextContent('Die Zahl ist noch nicht vollständig.');
    await user.clear(field()!); await user.type(field()!, '0,45'); await user.click(bidButton()!);
    expect(screen.getByRole('alert')).toHaveTextContent(/höchstens eine Nachkommastelle/);
    expect(onBid).not.toHaveBeenCalled();
    await user.clear(field()!); await user.type(field()!, '0.4'); await user.click(bidButton()!); // the point is a decimal sign too
    expect(onBid).toHaveBeenCalledWith({ ...origin(S1), value: { units: 4, scale: 1 } }); // the canonical object on the wire, never the string
  });
  it('the pass explains its consequence to assistive technology (aria-describedby points at the text)', () => {
    mount({ projection: standing(S1), onBid: vi.fn(), onPass: vi.fn() });
    const pass = passButton()!;
    const described = pass.getAttribute('aria-describedby');
    expect(described && document.getElementById(described)?.textContent).toMatch(/kannst nicht wieder einsteigen/);
  });
  it('a leader at the maximum cannot be outbid: the text says so and only the pass is offered', () => {
    mount({ projection: standing(S1, { leader: { teamId: 'T2', units: 999 } }), onBid: vi.fn(), onPass: vi.fn() });
    expect(screen.getByText('Höher bieten ist nicht möglich.')).toBeInTheDocument();
    expect(field()).not.toBeInTheDocument();
    expect(passButton()).toBeInTheDocument();
  });
  it('closed: the winner and the highest bid in words; aborted: "kein Ergebnis", no standing, no winner; prepared: no controls', () => {
    mount({ projection: standing({ sv: 9, bv: 6, qv: 5, turn: 6 }, { phase: 'CLOSED', leader: { teamId: 'T2', units: 8 }, onTurn: null, passed: ['T1', 'T3'] }), onBid: vi.fn(), onPass: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent('Beendet. Team Zwei gewinnt mit 8 Städte.');
    expect(field()).not.toBeInTheDocument();
    cleanup();
    mount({ projection: standing({ sv: 9, bv: 6, qv: 5, turn: 6 }, { phase: 'ABORTED', leader: { teamId: 'T2', units: 8 }, onTurn: null }), onBid: vi.fn(), onPass: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent('Das Bieten wurde abgebrochen. Es gibt kein Ergebnis.');
    expect(text()).not.toMatch(/gewinnt|Höchstgebot/);
    expect(screen.getAllByRole('listitem').map(li => li.textContent)).toEqual(['Team Einsim Rennen', 'Team Zweiim Rennen', 'Team Dreiim Rennen']); // nobody leads in an aborted bidding
    cleanup();
    mount({ projection: standing({ sv: 2, bv: 0, qv: 1, turn: 0 }, { phase: 'PREPARED', leader: null, onTurn: null }), onBid: vi.fn(), onPass: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent('Das Bieten beginnt gleich.');
    expect(field()).not.toBeInTheDocument();
  });
  it('a viewer / display packet (no `you`) shows the standing and NO control, even with callbacks given', () => {
    mount({ projection: standing(S1, { recipient: null, noYou: true }), expected: expectedFor(null), onBid: vi.fn(), onPass: vi.fn() });
    expect(text()).toContain('Höchstgebot: 5 Städte von Team Zwei.');
    expect(field()).not.toBeInTheDocument();
    expect(passButton()).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('shows a long team name wrapped, in every list entry', () => {
    const long = 'Ein sehr langer Teamname '.repeat(12).trim();
    mount({ projection: standing(S1), names: { ...NAMES, T2: long }, onBid: vi.fn(), onPass: vi.fn() });
    expect(text()).toContain(long);
  });
  it('without a projection or with an unavailable one the panel says so and renders no data', () => {
    mount({ projection: null });
    expect(text()).toContain('Das Bieten ist zurzeit nicht verfügbar.');
    expect(field()).not.toBeInTheDocument();
  });
});

describe('N10 BiddingPanel: the neutral view and the information rights', () => {
  const SECRETS = ['Hauptstädte', 'Kategorie', 'Städte', '731', 'Team Eins', 'Team Zwei', 'Team Drei', 'T1', 'T2', 'b1', 'b2', 'Höchstgebot', 'führt', 'gewinnt'];
  it('a PERFORMER sees exactly one neutral sentence — and the rendered DOM (text, attributes, aria, data) contains no category, bid, team or number', () => {
    const packet = neutral(7, { recipient: 'p1', performer: true });
    const utils = mount({ projection: packet, onBid: vi.fn(), onPass: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent('Dein Partner verhandelt gerade.');
    const html = utils.container.innerHTML;
    for (const needle of SECRETS) expect(html.includes(needle) ? needle : null, `leak: ${needle}`).toBeNull();
    expect(utils.container.querySelectorAll('input, textarea, [contenteditable], button, li, ul').length).toBe(0); // no hidden input, no control, no list
    expect(Object.keys(packet).sort()).toEqual(['contract', 'phase', 'recipientId', 'release', 'scope', 'stateVersion', 'you']); // and the received JSON had none of it either
    for (const needle of SECRETS.filter(n => !['T1', 'T2', 'b1', 'b2'].includes(n))) expect(JSON.stringify(packet).includes(needle)).toBe(false);
  });
  it('another player (not performer) sees "Das Bieten läuft."; after the end only "beendet" — no winner, no result', () => {
    mount({ projection: neutral(7, { recipient: 'p1', performer: false }) });
    expect(screen.getByRole('status')).toHaveTextContent('Das Bieten läuft.');
    cleanup();
    const utils = mount({ projection: neutral(12, { recipient: 'p1', phase: 'ENDED' }) });
    expect(screen.getByRole('status')).toHaveTextContent('Das Bieten ist beendet.');
    for (const needle of SECRETS) expect(utils.container.innerHTML.includes(needle) ? needle : null).toBeNull();
  });
  it('a STANDING packet that arrives for a performer recipient under the performer\'s expectation is no packet for the neutral role — it is accepted only as what the server sent; the server never sends it (projection refuses), the panel adds nothing of its own', () => {
    // the panel renders what the server released; with `you.teamId === null` it offers no control whatever else the packet says
    mount({ projection: standing(S1, { recipient: 'p1', youTeam: null }), expected: expectedFor('p1'), onBid: vi.fn(), onPass: vi.fn() });
    expect(field()).not.toBeInTheDocument();
    expect(passButton()).not.toBeInTheDocument();
  });
  it('the neutral view of a performer is not replaced by an older released packet later (neutral → withdrawal → late released bidder packet)', () => {
    const { set } = mount({ projection: neutral(9, { recipient: 'b1', performer: false }) });
    set({ projection: null });
    set({ projection: standing({ sv: 8, bv: 7, qv: 4, turn: 7 }) });
    expect(text()).toContain('Das Bieten ist zurzeit nicht verfügbar.');
    expect(text()).not.toContain('Hauptstädte');
    expect(field()).not.toBeInTheDocument();
  });
});

describe('N10 BiddingPanel: binding before rendering, ordering, withdrawal', () => {
  it('a foreign recipient, another bidding, another round, another roles revision or a too-old snapshot never reaches the markup — not even for one frame', () => {
    for (const projection of [
      standing(S1, { recipient: 'b2', youTeam: 'T2' }), standing(S1, { scope: { biddingId: 'other' } }), standing(S1, { scope: { roundId: 'other' } }),
      standing(S1, { scope: { rolesRevision: 'other' } }), standing(S1, { scope: { runIndex: 2 } }),
    ]) {
      const markup = renderToStaticMarkup(<BiddingPanel expected={expectedFor('b1')} projection={projection} names={NAMES} onBid={() => undefined} onPass={() => undefined} />);
      expect(markup).toContain('zurzeit nicht verfügbar');
      for (const needle of ['Hauptstädte', 'Team Zwei', 'Dein Gebot']) expect(markup.includes(needle)).toBe(false);
    }
    const tooOld = renderToStaticMarkup(<BiddingPanel expected={expectedFor('b1', 9)} projection={standing(S1)} names={NAMES} onBid={() => undefined} />);
    expect(tooOld).toContain('zurzeit nicht verfügbar');
  });
  it('current → withdrawn (null) → an OLDER view: nothing comes back; a newer one does', () => {
    const { set } = mount({ projection: standing(S1), onBid: vi.fn(), onPass: vi.fn() });
    expect(field()).toBeInTheDocument();
    set({ projection: null });
    expect(field()).not.toBeInTheDocument();
    expect(text()).toContain('zurzeit nicht verfügbar');
    set({ projection: standing({ ...S1, bv: 1 }) });
    expect(field()).not.toBeInTheDocument();
    set({ projection: standing({ ...S1, sv: 6, bv: 4 }) });
    expect(field()).toBeInTheDocument();
  });
  it('closed → invalid → an old "may bid" view: no control comes back', () => {
    const { set } = mount({ projection: standing({ sv: 9, bv: 6, qv: 5, turn: 6 }, { phase: 'CLOSED', leader: { teamId: 'T2', units: 8 }, onTurn: null, passed: ['T1', 'T3'] }), onBid: vi.fn(), onPass: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent('Team Zwei gewinnt mit 8'); // precondition: the closed view really is shown (a schema-invalid fixture would show nothing)
    set({ projection: { garbage: 1 } as unknown as BiddingProjection });
    set({ projection: standing({ sv: 8, bv: 5, qv: 4, turn: 5 }) });
    expect(field()).not.toBeInTheDocument();
    expect(passButton()).not.toBeInTheDocument();
    expect(text()).toContain('zurzeit nicht verfügbar');
  });
  it('a newer eligibility basis without a bid (higher sequence version only) is accepted and the older stand is refused afterwards', () => {
    const { set } = mount({ projection: standing(S1), onBid: vi.fn(), onPass: vi.fn() });
    set({ projection: standing({ ...S1, sv: 6, qv: 3 }) });
    expect(field()).toBeInTheDocument();
    set({ projection: standing(S1) });
    expect(field()).toBeInTheDocument(); // the shown view stays the newer one
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
  it('a new bidding in a new context starts with empty knowledge; a late packet of the old bidding then shows nothing', () => {
    const next = { biddingId: 'bidding-2' };
    const { rerender } = render(<BiddingPanel expected={expectedFor('b1')} projection={standing({ sv: 90, bv: 40, qv: 30, turn: 40 })} names={NAMES} onBid={vi.fn()} />);
    rerender(<BiddingPanel expected={expectedFor('b1', 0, next)} projection={standing({ sv: 1, bv: 1, qv: 1, turn: 1 }, { scope: next })} names={NAMES} onBid={vi.fn()} />);
    expect(field()).toBeInTheDocument();
    rerender(<BiddingPanel expected={expectedFor('b1', 0, next)} projection={standing({ sv: 91, bv: 41, qv: 31, turn: 41 })} names={NAMES} onBid={vi.fn()} />);
    expect(field()).not.toBeInTheDocument();
    expect(text()).toContain('zurzeit nicht verfügbar');
  });
});

describe('N10 BiddingPanel: sending — one intent per binding', () => {
  it('a bid carries the COMPLETE origin of the SHOWN view: target, team, turn, sequence version, bidding version and ONE canonical value — nothing else', async () => {
    const user = userEvent.setup();
    const onBid = vi.fn();
    mount({ projection: standing(S1), onBid, onPass: vi.fn() });
    await user.type(field()!, '9');
    await user.click(bidButton()!);
    expect(onBid).toHaveBeenCalledTimes(1);
    expect(onBid).toHaveBeenCalledWith({ ...origin(S1), value: { units: 9, scale: 0 } });
    expect(Object.keys(onBid.mock.calls[0][0]).sort()).toEqual(['biddingVersion', 'scope', 'sequenceVersion', 'teamId', 'turnNumber', 'value']); // no winner, no leader, no highest bid
  });
  it('a pass carries the same origin and nothing else', async () => {
    const user = userEvent.setup();
    const onPass = vi.fn();
    mount({ projection: standing(S1), onBid: vi.fn(), onPass });
    await user.click(passButton()!);
    expect(onPass).toHaveBeenCalledTimes(1);
    expect(onPass).toHaveBeenCalledWith(origin(S1));
    expect(Object.keys(onPass.mock.calls[0][0]).sort()).toEqual(['biddingVersion', 'scope', 'sequenceVersion', 'teamId', 'turnNumber']);
  });
  it('the intent is made from the VIEW that is shown, not from the expected context or later props: another view later gives another origin', async () => {
    const user = userEvent.setup();
    const onBid = vi.fn();
    const { set } = mount({ projection: standing(S1), onBid, onPass: vi.fn() });
    set({ projection: standing({ sv: 8, bv: 5, qv: 4, turn: 5 }) });
    await user.type(field()!, '12');
    await user.click(bidButton()!);
    expect(onBid).toHaveBeenCalledWith({ ...origin({ sv: 8, bv: 5, qv: 4, turn: 5 }), value: { units: 12, scale: 0 } });
  });
  it('a double click on the bid sends once; a pass right after on the SAME binding and a bid right after a pass send nothing second', async () => {
    const user = userEvent.setup();
    const onBid = vi.fn(), onPass = vi.fn();
    mount({ projection: standing(S1), onBid, onPass });
    await user.type(field()!, '9');
    await user.dblClick(bidButton()!);
    expect(onBid).toHaveBeenCalledTimes(1);
    await user.click(passButton()!);
    expect(onPass).not.toHaveBeenCalled();
    expect(passButton()).toHaveAttribute('aria-disabled', 'true');
    cleanup();
    const onBid2 = vi.fn(), onPass2 = vi.fn();
    mount({ projection: standing(S1), onBid: onBid2, onPass: onPass2 });
    await user.type(field()!, '9');
    await user.click(passButton()!);
    expect(onPass2).toHaveBeenCalledTimes(1);
    await user.click(bidButton()!);
    expect(onBid2).not.toHaveBeenCalled();
    await user.dblClick(passButton()!);
    expect(onPass2).toHaveBeenCalledTimes(1);
  });
  it('two presses inside ONE tick (same render closure) send once: a bid and a pass fired together, and a pass pressed twice', async () => {
    const onBid = vi.fn(), onPass = vi.fn();
    mount({ projection: standing(S1), onBid, onPass });
    fireEvent.change(field()!, { target: { value: '9' } });
    const submit = bidButton()!, pass = passButton()!;
    act(() => { fireEvent.submit(submit.closest('form')!); pass.click(); }); // nothing re-renders between the two presses
    expect(onBid.mock.calls.length + onPass.mock.calls.length).toBe(1);
    expect(onPass).not.toHaveBeenCalled();
    cleanup();
    const onPass2 = vi.fn();
    mount({ projection: standing(S1), onBid: vi.fn(), onPass: onPass2 });
    const p = passButton()!;
    act(() => { p.click(); p.click(); });
    expect(onPass2).toHaveBeenCalledTimes(1);
  });
  it('a REJECTED report releases the binding ONCE per report: a second identical rejection (distinguished by its id) releases the next send again, a repeated old report does not', async () => {
    const user = userEvent.setup();
    const onPass = vi.fn();
    const key = biddingActionBindingKey(origin(S1));
    const { set } = mount({ projection: standing(S1), onBid: vi.fn(), onPass });
    await user.click(passButton()!);
    expect(onPass).toHaveBeenCalledTimes(1);
    set({ feedback: { bindingKey: key, status: 'REJECTED', id: 1 } });
    await user.click(passButton()!); // the report released it: ONE new send
    expect(onPass).toHaveBeenCalledTimes(2);
    set({ feedback: { bindingKey: key, status: 'REJECTED', id: 1 } }); // the SAME report again (re-render with an equal object): no new release
    await user.click(passButton()!);
    expect(onPass).toHaveBeenCalledTimes(2);
    set({ feedback: { bindingKey: key, status: 'REJECTED', id: 2 } }); // a NEW identical rejection
    await user.click(passButton()!);
    expect(onPass).toHaveBeenCalledTimes(3);
  });
  it('identical props created anew, a re-render and a theme change do not open the lock again (the command count is what counts)', async () => {
    const user = userEvent.setup();
    const onBid = vi.fn(), onPass = vi.fn();
    function Themed() {
      const { setTheme, setAccent } = useTheme();
      const [tick, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => { setTheme('light'); setAccent(ACCENTS[2].id); setTick(t => t + 1); }}>wechsel</button>
          <button type="button" onClick={() => setTick(t => t + 1)}>tick {tick}</button>
          <BiddingPanel expected={{ ...expectedFor('b1') }} projection={clone(standing(S1))} names={{ ...NAMES }} onBid={onBid} onPass={onPass} feedback={{ bindingKey: 'x', status: 'PENDING' }} />
        </>
      );
    }
    render(<ThemeProvider><Themed /></ThemeProvider>);
    await user.click(passButton()!);
    expect(onPass).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /^tick/ }));
    await user.click(screen.getByRole('button', { name: 'wechsel' }));
    expect(document.documentElement.dataset.accent).toBe(ACCENTS[2].id);
    const locked = screen.getByRole('button', { name: 'Gesendet' });
    expect(locked).toHaveAttribute('aria-disabled', 'true');
    expect(locked).not.toBeDisabled(); // aria-disabled, NOT disabled: a focused control that becomes disabled loses keyboard focus
    await user.click(locked);
    expect(onPass).toHaveBeenCalledTimes(1);
    expect(onBid).not.toHaveBeenCalled();
  });
  it('a NEW binding (another bidding version / turn) is a new chance: the controls are free again; the lock of the old binding neither unlocks nor blocks it', async () => {
    const user = userEvent.setup();
    const onPass = vi.fn();
    const { set } = mount({ projection: standing(S1), onBid: vi.fn(), onPass });
    await user.click(passButton()!);
    expect(onPass).toHaveBeenCalledTimes(1);
    set({ projection: standing({ sv: 6, bv: 4, qv: 3, turn: 4 }, { onTurn: 'T1' }) });
    await user.click(passButton()!);
    expect(onPass).toHaveBeenCalledTimes(2);
    expect(onPass).toHaveBeenLastCalledWith(origin({ sv: 6, bv: 4, qv: 3, turn: 4 }));
  });
  it('a rejected promise or REJECTED feedback of exactly THIS binding unlocks exactly this binding; late settlements of an OLD binding change nothing', async () => {
    const user = userEvent.setup();
    const first = deferred();
    const onPass = vi.fn(() => first.promise);
    const { set } = mount({ projection: standing(S1), onBid: vi.fn(), onPass });
    await user.click(passButton()!);
    expect(passButton()).toHaveAttribute('aria-disabled', 'true');
    await act(async () => { first.reject(new Error('refused')); await first.promise.catch(() => undefined); });
    expect(passButton()).not.toHaveAttribute('aria-disabled');
    await user.click(passButton()!);
    expect(onPass).toHaveBeenCalledTimes(2);
    // the same binding rejected by feedback: unlocked
    const key = biddingActionBindingKey(origin(S1));
    set({ feedback: { bindingKey: key, status: 'REJECTED', message: 'Veraltet.' } });
    expect(passButton()).not.toHaveAttribute('aria-disabled');
    // feedback of ANOTHER binding changes nothing
    cleanup();
    const onPass2 = vi.fn();
    const m = mount({ projection: standing(S1), onBid: vi.fn(), onPass: onPass2 });
    await user.click(passButton()!);
    m.set({ feedback: { bindingKey: biddingActionBindingKey(origin({ ...S1, bv: 99 })), status: 'REJECTED' } });
    expect(passButton()).toHaveAttribute('aria-disabled', 'true');
    // a late ACK of the OLD binding after a newer binding is shown: the new binding is free and unaffected
    m.set({ projection: standing({ sv: 6, bv: 4, qv: 3, turn: 4 }) });
    expect(passButton()).not.toHaveAttribute('aria-disabled');
  });
  it('the bid field keeps its attempt per binding: REJECTED feedback makes the SAME draft retryable, ACCEPTED shows the sent value read-only; PENDING does not send again', async () => {
    const user = userEvent.setup();
    const onBid = vi.fn();
    const key = biddingActionBindingKey(origin(S1));
    const { set } = mount({ projection: standing(S1), onBid, onPass: vi.fn() });
    await user.type(field()!, '9');
    await user.click(bidButton()!);
    expect(onBid).toHaveBeenCalledTimes(1);
    set({ feedback: { bindingKey: key, status: 'PENDING' } });
    await user.click(screen.getByRole('button', { name: /Wird gesendet|Bieten/ }));
    expect(onBid).toHaveBeenCalledTimes(1);
    set({ feedback: { bindingKey: key, status: 'REJECTED', message: 'Das Gebot wurde abgelehnt.' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Das Gebot wurde abgelehnt.');
    await user.click(screen.getByRole('button', { name: 'Erneut senden' }));
    expect(onBid).toHaveBeenCalledTimes(2);
    expect(onBid).toHaveBeenLastCalledWith({ ...origin(S1), value: { units: 9, scale: 0 } });
    set({ feedback: { bindingKey: key, status: 'ACCEPTED' } });
    expect(field()).toHaveValue('9');
    expect(field()).toHaveAttribute('readonly');
  });
  it('never calls a callback by itself: mount, StrictMode, re-renders, new props objects, timers, theme changes, an arriving projection and a reload', async () => {
    vi.useFakeTimers();
    const onBid = vi.fn(), onPass = vi.fn();
    const { set, unmount } = mount({ projection: standing(S1), onBid, onPass });
    set({ projection: standing({ ...S1, sv: 6, bv: 4, qv: 3, turn: 4 }) });
    set({ projection: clone(standing({ ...S1, sv: 6, bv: 4, qv: 3, turn: 4 })) });
    set({ projection: neutral(7, { recipient: 'b1', performer: false }) });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    unmount();
    render(<StrictMode><BiddingPanel expected={expectedFor('b1')} projection={standing(S1)} names={NAMES} onBid={onBid} onPass={onPass} /></StrictMode>);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(onBid).not.toHaveBeenCalled();
    expect(onPass).not.toHaveBeenCalled();
  });
  it('keyboard: Tab reaches the field and the pass, Enter in the field sends the bid, the focus STAYS in the input after sending; the pass is reachable by Tab and sent by Space, focus stays on it', async () => {
    const user = userEvent.setup();
    const onBid = vi.fn(), onPass = vi.fn();
    mount({ projection: standing(S1), onBid, onPass });
    await user.tab();
    expect(field()).toHaveFocus();
    await user.keyboard('11{Enter}');
    expect(onBid).toHaveBeenCalledTimes(1);
    expect(field()).toHaveFocus(); // sending locks the input read-only, it does not take the keyboard focus away
    cleanup();
    const onPass2 = vi.fn();
    mount({ projection: standing(S1), onBid: vi.fn(), onPass: onPass2 });
    await user.tab(); await user.tab(); await user.tab();
    expect(passButton()).toHaveFocus();
    await user.keyboard(' ');
    expect(onPass2).toHaveBeenCalledTimes(1);
    expect(passButton()).toHaveFocus(); // aria-disabled keeps the focus where it is
    await user.keyboard('{Enter}');
    expect(onPass2).toHaveBeenCalledTimes(1);
  });
  it('a local validation error (empty / not a number) sends nothing and does not take the lock', async () => {
    const user = userEvent.setup();
    const onBid = vi.fn();
    mount({ projection: standing(S1), onBid, onPass: vi.fn() });
    await user.click(bidButton()!);
    await user.type(field()!, 'abc');
    await user.click(bidButton()!);
    expect(onBid).not.toHaveBeenCalled();
    expect(passButton()).not.toHaveAttribute('aria-disabled');
    await user.clear(field()!);
    await user.type(field()!, '7,5');
    await user.click(bidButton()!);
    expect(onBid).not.toHaveBeenCalled(); // a decimal in a whole-number profile: no rounding
    expect(screen.getByRole('alert')).toHaveTextContent(/ganze Zahlen/);
  });
});

describe('N10 BiddingPanel: presentation', () => {
  it('renders the same text under every accent and both themes (tokens switch, markup does not)', () => {
    const projection = standing(S1);
    const markup = renderToStaticMarkup(<ThemeProvider><BiddingPanel expected={expectedFor('b1')} projection={projection} names={NAMES} onBid={() => undefined} onPass={() => undefined} /></ThemeProvider>);
    function Switcher() {
      const { setTheme, setAccent } = useTheme();
      return (<button type="button" onClick={() => { setTheme('light'); setAccent(ACCENTS[ACCENTS.length - 1].id); }}>wechsel</button>);
    }
    render(<ThemeProvider><Switcher /><BiddingPanel expected={expectedFor('b1')} projection={projection} names={NAMES} onBid={() => undefined} onPass={() => undefined} /></ThemeProvider>);
    const before = screen.getByRole('status').textContent;
    fireEvent.click(screen.getByRole('button', { name: 'wechsel' }));
    expect(document.documentElement.dataset.accent).toBe(ACCENTS[ACCENTS.length - 1].id);
    expect(screen.getByRole('status').textContent).toBe(before);
    expect(markup).toContain('Dein Gebot');
  });
  it('the style sheet uses Midnight tokens only (no colour literals), no glow, no fixed widths, and respects reduced motion by having no motion at all', () => {
    const css = readFileSync(resolve(__dirname, 'BiddingPanel.module.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(css).not.toMatch(/box-shadow|text-shadow|filter\s*:\s*drop-shadow|animation|transition/);
    expect(css).not.toMatch(/(^|[\s;{])width\s*:\s*\d/m);
  });
});
