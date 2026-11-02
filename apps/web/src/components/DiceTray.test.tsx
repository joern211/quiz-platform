import { StrictMode, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme, ACCENTS } from '@quiz/ui';
import { DICE_CONTRACT, type DiceExpectedContext, type DiceHoldIntent, type DiceProjection, type DiceRollIntent } from '@quiz/shared/dice';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiceTray } from './DiceTray';

afterEach(() => { cleanup(); vi.useRealTimers(); });

// Synthetic fixtures: markers instead of game content.
const SCOPE = { runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'PLAYER' as const };
const EXPECTED: DiceExpectedContext = { ...SCOPE, recipientId: 'p1', minStateVersion: 1 };
const CONFIG = { diceCount: 5, sides: 6, maxRolls: 3, holdAllowed: true };
const SINGLE = { diceCount: 1, sides: 6, maxRolls: 1, holdAllowed: false };
interface Stand { state: number; seq: number; turn: number; dv: number; roll: number }
interface Over { recipient?: string | null; holder?: string; held?: boolean[]; values?: number[]; closed?: boolean; unit?: 'PLAYER' | 'TEAM'; config?: typeof CONFIG; canRoll?: boolean; teamHolds?: boolean }

function view(stand: Stand, over: Over = {}): DiceProjection {
  const recipient = over.recipient === undefined ? 'p1' : over.recipient;
  const config = over.config ?? CONFIG;
  const team = over.unit === 'TEAM';
  const status = over.closed ? 'CLOSED' : stand.roll === 0 ? 'PREPARED' : stand.roll >= config.maxRolls ? 'EXHAUSTED' : 'IN_PROGRESS';
  const holderId = over.holder ?? 'p1';
  const holds = recipient !== null && recipient === holderId;
  const open = status === 'PREPARED' || status === 'IN_PROGRESS';
  const held = over.held ?? Array.from({ length: config.diceCount }, () => false);
  const you = recipient === null ? null : { holdsTurn: holds, teamHoldsTurn: team ? (over.teamHolds ?? holds) : null, canRoll: (over.canRoll ?? true) && holds && open && held.some(h => !h), canHold: holds && status === 'IN_PROGRESS' && config.holdAllowed };
  return {
    contract: DICE_CONTRACT, scope: { ...SCOPE, unit: over.unit ?? 'PLAYER' }, diceId: `dice-t${stand.turn}`, recipientId: recipient, stateVersion: stand.state, sequenceVersion: stand.seq, turnNumber: stand.turn, diceVersion: stand.dv, rollCount: stand.roll,
    release: 'VALUES', status, config: { ...config }, values: stand.roll === 0 ? null : over.values ?? Array.from({ length: config.diceCount }, (_, i) => i + 1), held,
    lastRolled: stand.roll === 0 ? [] : stand.roll === 1 ? Array.from({ length: config.diceCount }, (_, i) => i) : [0, 2], holder: { teamId: team ? 'T1' : null, playerId: holderId }, you,
  } as DiceProjection;
}
const none = (stand: Stand): DiceProjection => ({ contract: DICE_CONTRACT, scope: { ...SCOPE }, diceId: 'dice-t1', recipientId: 'p1', stateVersion: stand.state, sequenceVersion: stand.seq, turnNumber: stand.turn, diceVersion: stand.dv, rollCount: stand.roll, release: 'NONE' });
const PREPARED: Stand = { state: 5, seq: 2, turn: 1, dv: 0, roll: 0 };
const ROLL1: Stand = { state: 6, seq: 2, turn: 1, dv: 1, roll: 1 };
const text = () => document.body.textContent ?? '';
/** The origin an intent must carry for a fixture of turn `turn`: target (scope + process) next to the counters. */
const origin = (turn: number, counters: { sequenceVersion: number; diceVersion: number; rollCount: number }) => ({ scope: { ...SCOPE }, diceId: `dice-t${turn}`, turnNumber: turn, ...counters });
const dieButtons = () => screen.queryAllByRole('button', { name: /^Würfel \d/ });

interface Mount { expected?: DiceExpectedContext; projection?: DiceProjection | null; names?: Record<string, string>; onRoll?: (i: DiceRollIntent) => void | Promise<unknown>; onHold?: (i: DiceHoldIntent) => void | Promise<unknown>; label?: string }
function mount(over: Mount = {}) {
  const base = { expected: EXPECTED, projection: view(ROLL1) as DiceProjection | null, ...over };
  if (over.expected === undefined && base.projection !== null && base.projection !== undefined) base.expected = { ...EXPECTED, recipientId: base.projection.recipientId };
  const utils = render(<DiceTray {...base} />);
  return { ...utils, set: (next: Mount) => utils.rerender(<DiceTray {...base} {...next} />) };
}
const deferred = () => { let resolve!: (v?: unknown) => void, reject!: (e?: unknown) => void; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

describe('N9 DiceTray: what is shown', () => {
  it('before the first roll there are NO dice values at all — text only, no placeholder digit, no empty die', () => {
    mount({ projection: view(PREPARED), onRoll: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent('Noch nicht gewürfelt.');
    expect(screen.queryByRole('list', { name: 'Würfel' })).not.toBeInTheDocument();
    expect(dieButtons()).toHaveLength(0);
    expect(screen.queryByText(/^Würfel \d$/)).not.toBeInTheDocument(); // no die is drawn, so no die caption either
    expect(screen.getByRole('button', { name: 'Würfeln' })).toBeEnabled();
    expect(screen.getByText('0 von 3')).toBeInTheDocument();
  });

  it('shows the values BY POSITION in the stored order — never sorted by face value — and which dice are held, as text and as aria-pressed', () => {
    mount({ projection: view(ROLL1, { values: [4, 4, 1, 1, 6], held: [false, true, false, false, true] }), onHold: vi.fn(), onRoll: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent('Wurf 1 von 3: 4, 4, 1, 1, 6.');
    const items = screen.getAllByRole('listitem');
    expect(items.map(li => li.textContent)).toEqual(['Würfel 14Frei', 'Würfel 24Gehalten', 'Würfel 31Frei', 'Würfel 41Frei', 'Würfel 56Gehalten']);
    const buttons = dieButtons();
    expect(buttons.map(b => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false', 'true']);
    expect(buttons[1]).toHaveTextContent('Gehalten'); // the state is a word, not only a colour or a frame
  });

  it('states: in progress, exhausted, closed with and without values — each in words', () => {
    mount({ projection: view({ ...ROLL1, roll: 2, dv: 3 }, { values: [2, 2, 2, 2, 2] }) });
    expect(screen.getByRole('status')).toHaveTextContent('Wurf 2 von 3: 2, 2, 2, 2, 2.');
    cleanup();
    mount({ projection: view({ ...ROLL1, roll: 3, dv: 5 }, { values: [3, 3, 3, 3, 3] }), onRoll: vi.fn(), onHold: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent('Wurf 3 von 3, kein weiterer Wurf: 3, 3, 3, 3, 3.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument(); // nothing to do any more
    expect(screen.getByText('Im Moment ist keine Aktion möglich.')).toBeInTheDocument();
    cleanup();
    mount({ projection: view({ ...ROLL1, dv: 4 }, { closed: true, values: [6, 6, 6, 6, 6] }), onRoll: vi.fn(), onHold: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent('Beendet. Ergebnis: 6, 6, 6, 6, 6.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    cleanup();
    mount({ projection: { ...view(PREPARED, { closed: true }), status: 'CLOSED' } as DiceProjection });
    expect(screen.getByRole('status')).toHaveTextContent('Beendet.');
  });

  it('a viewer, a display and a non-playing host see the values and no control, even with callbacks supplied', () => {
    mount({ projection: view(ROLL1, { recipient: null, values: [5, 4, 3, 2, 1] }), onRoll: vi.fn(), onHold: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent('Wurf 1 von 3: 5, 4, 3, 2, 1.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Du bist am Zug.')).not.toBeInTheDocument();
  });

  it('a player who is not on turn, and a teammate, see the values and may only advise', () => {
    mount({ projection: view(ROLL1, { recipient: 'p2', holder: 'p1' }), onRoll: vi.fn(), onHold: vi.fn() });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    cleanup();
    const team = view({ ...ROLL1 }, { recipient: 'm2', holder: 'm1', unit: 'TEAM', teamHolds: true });
    mount({ expected: { ...EXPECTED, unit: 'TEAM', recipientId: 'm2' }, projection: team, names: { T1: 'Rote Rakete', m1: 'Max' }, onRoll: vi.fn(), onHold: vi.fn() });
    expect(screen.getByText('Dein Team ist am Zug. Du kannst beraten.')).toBeInTheDocument();
    expect(screen.getByText('Rote Rakete')).toBeInTheDocument();
    expect(screen.getByText('Max')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('the holder is offered the roll and the holds; without callbacks nothing is offered; the single-die profile has no holding', () => {
    mount({ onRoll: vi.fn(), onHold: vi.fn() });
    expect(screen.getByText('Du bist am Zug.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Würfeln' })).toBeInTheDocument();
    expect(dieButtons()).toHaveLength(5);
    cleanup();
    mount({});
    expect(screen.queryByRole('button')).not.toBeInTheDocument(); // read-only without callbacks
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    cleanup();
    mount({ projection: view({ ...PREPARED }, { config: SINGLE as never }), onRoll: vi.fn(), onHold: vi.fn() });
    expect(screen.getByRole('button', { name: 'Würfeln' })).toBeInTheDocument();
    cleanup();
    mount({ projection: view(ROLL1, { config: SINGLE as never, values: [4] }), onRoll: vi.fn(), onHold: vi.fn() });
    expect(screen.queryByRole('button')).not.toBeInTheDocument(); // one die, one roll: nothing left
    expect(screen.getByRole('status')).toHaveTextContent('kein weiterer Wurf: 4.');
  });

  it('all dice held: the roll is not offered and the reason is said in words', () => {
    mount({ projection: view(ROLL1, { held: [true, true, true, true, true] }), onRoll: vi.fn(), onHold: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Würfeln' })).not.toBeInTheDocument();
    expect(screen.getByText('Alle Würfel sind gehalten. Gib mindestens einen frei, um zu würfeln.')).toBeInTheDocument();
    expect(dieButtons().every(b => b.getAttribute('aria-pressed') === 'true')).toBe(true); // they can still be released
  });

  it('shows names from the caller\'s own mapping, falls back to the id, and wraps long names (overflow-wrap in the stylesheet)', () => {
    const long = 'Ein sehr langer Name '.repeat(8) + 'Donaudampfschifffahrtsgesellschaftskapitänsmütze';
    mount({ projection: view(ROLL1, { holder: 'p1' }), names: { p1: long } });
    expect(screen.getByText(long)).toBeInTheDocument();
    cleanup();
    mount({ projection: view(ROLL1, { recipient: null, holder: 'p7' }) });
    expect(screen.getByText('p7')).toBeInTheDocument();
    const css = readFileSync(resolve(process.cwd(), 'src/components/DiceTray.module.css'), 'utf8');
    expect(css).toMatch(/\.value\s*\{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.card\s*\{[^}]*min-width: 0/);
  });

  it('shows nothing — not even for one frame — for a foreign, stale, malformed or missing projection', () => {
    const markup = (projection: unknown, expected: DiceExpectedContext = EXPECTED) => renderToStaticMarkup(<DiceTray expected={expected} projection={projection as DiceProjection} onRoll={() => undefined} />);
    for (const bad of [view(ROLL1, { recipient: 'p2', values: [6, 6, 6, 6, 6] }), view(ROLL1, { recipient: null }), { ...view(ROLL1), values: [0, 0, 0, 0, 0] }, null, undefined, 'x']) {
      const html = markup(bad);
      expect(html).toContain('Die Würfel sind zurzeit nicht verfügbar.');
      expect(html).not.toMatch(/Würfel 1|Würfeln|Gehalten/);
    }
    expect(markup(view({ ...ROLL1, state: 2 }), { ...EXPECTED, minStateVersion: 3 })).toContain('nicht verfügbar'); // older than the caller's own minimum
    expect(markup(view({ ...ROLL1, turn: 1 }), { ...EXPECTED, sequenceId: 'seq-2' })).toContain('nicht verfügbar'); // another sequence
    expect(markup(view(ROLL1))).toContain('Würfel 1'); // positive control
    expect(markup(none(ROLL1))).toContain('nicht verfügbar'); // release NONE shows nothing
  });
});

describe('N9 DiceTray: sending', () => {
  it('the roll sends exactly the binding that is shown — and nothing else: no values, no seed', async () => {
    const user = userEvent.setup();
    const onRoll = vi.fn();
    mount({ projection: view({ state: 9, seq: 4, turn: 3, dv: 2, roll: 1 }), onRoll });
    await user.click(screen.getByRole('button', { name: 'Würfeln' }));
    expect(onRoll).toHaveBeenCalledTimes(1);
    expect(onRoll).toHaveBeenCalledWith(origin(3, { sequenceVersion: 4, diceVersion: 2, rollCount: 1 }));
    expect(Object.keys(onRoll.mock.calls[0][0]).sort()).toEqual(['diceId', 'diceVersion', 'rollCount', 'scope', 'sequenceVersion', 'turnNumber']);
  });

  it('every intent carries the ORIGIN it was made for — target (run, sequence, roster revision, unit, process) next to the counters — taken from the projection that is SHOWN, also for a team unit (N9-01)', async () => {
    const user = userEvent.setup();
    const onRoll = vi.fn(), onHold = vi.fn();
    const team = { ...view({ ...ROLL1, turn: 7 }, { unit: 'TEAM', recipient: 'm1', holder: 'm1' }) } as DiceProjection;
    const scope = { runIndex: 3, sequenceId: 'seq-run3', rosterRevision: 'roster-9', unit: 'TEAM' as const };
    const shown = { ...team, scope, diceId: 'dice-seven' } as DiceProjection;
    mount({ expected: { ...scope, recipientId: 'm1', minStateVersion: 1 }, projection: shown, onRoll, onHold });
    await user.click(screen.getByRole('button', { name: 'Würfeln' }));
    expect(onRoll).toHaveBeenCalledWith({ scope, diceId: 'dice-seven', turnNumber: 7, sequenceVersion: 2, diceVersion: 1, rollCount: 1 });
    cleanup();
    mount({ expected: { ...scope, recipientId: 'm1', minStateVersion: 1 }, projection: shown, onRoll, onHold });
    await user.click(dieButtons()[2]);
    expect(onHold).toHaveBeenCalledWith({ scope, diceId: 'dice-seven', turnNumber: 7, sequenceVersion: 2, diceVersion: 1, rollCount: 1, held: [2] });
    // the emitted target is a COPY: changing it can not change what is shown or what the next intent carries
    onHold.mock.calls[0][0].scope.sequenceId = 'tampered';
    expect(shown.scope.sequenceId).toBe('seq-run3');
  });

  it('two valid contexts that show IDENTICAL counters emit DIFFERENT intents — for roll and for hold (the independent reproduction of N9-01)', async () => {
    const user = userEvent.setup();
    for (const kind of ['ROLL', 'HOLD'] as const) {
      const send = vi.fn();
      const packet = (sequenceId: string) => ({ ...view(kind === 'HOLD' ? ROLL1 : PREPARED), scope: { ...SCOPE, sequenceId }, diceId: `dice-${sequenceId}` }) as DiceProjection;
      const props = (p: DiceProjection) => ({ projection: p, expected: { ...p.scope, recipientId: 'p1', minStateVersion: 1 }, onRoll: send, onHold: send });
      const view1 = render(<DiceTray {...props(packet('seq-old'))} />);
      const click = () => user.click(kind === 'ROLL' ? screen.getByRole('button', { name: 'Würfeln' }) : dieButtons()[0]);
      await click();
      view1.rerender(<DiceTray {...props(packet('seq-new'))} />);
      await click();
      expect(send).toHaveBeenCalledTimes(2); // both are current and actionable when clicked: the lock is per origin, not per counters
      const [first, second] = [send.mock.calls[0][0], send.mock.calls[1][0]];
      expect([first.turnNumber, first.sequenceVersion, first.diceVersion, first.rollCount]).toEqual([second.turnNumber, second.sequenceVersion, second.diceVersion, second.rollCount]);
      expect(first).not.toEqual(second);
      expect(first.scope.sequenceId).toBe('seq-old');
      expect(second.scope.sequenceId).toBe('seq-new');
      expect(first.diceId).toBe('dice-seq-old');
      cleanup();
    }
  });

  it('a hold click sends the COMPLETE target assignment (the shown one with that die flipped), never a toggle', async () => {
    const user = userEvent.setup();
    const onHold = vi.fn();
    const { set } = mount({ projection: view(ROLL1, { held: [false, true, false, false, false] }), onHold });
    await user.click(dieButtons()[3]);
    expect(onHold).toHaveBeenLastCalledWith({ ...origin(1, { sequenceVersion: 2, diceVersion: 1, rollCount: 1 }), held: [1, 3] });
    set({ projection: view({ ...ROLL1, state: 7, dv: 2 }, { held: [false, true, false, true, false] }) }); // the server confirmed: a new binding
    await user.click(dieButtons()[1]); // release the held die
    expect(onHold).toHaveBeenLastCalledWith({ ...origin(1, { sequenceVersion: 2, diceVersion: 2, rollCount: 1 }), held: [3] });
    expect(onHold).toHaveBeenCalledTimes(2);
  });

  it('holding works with the keyboard: Tab reaches a die, Enter and Space flip it', async () => {
    const user = userEvent.setup();
    const onHold = vi.fn();
    const { set } = mount({ projection: view(ROLL1), onHold });
    await user.tab();
    expect(dieButtons()[0]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onHold).toHaveBeenLastCalledWith(expect.objectContaining({ held: [0] }));
    set({ projection: view({ ...ROLL1, state: 7, dv: 2 }, { held: [true, false, false, false, false] }) });
    await user.tab();
    expect(dieButtons()[1]).toHaveFocus();
    await user.keyboard(' ');
    expect(onHold).toHaveBeenLastCalledWith(expect.objectContaining({ held: [0, 1] }));
    expect(onHold).toHaveBeenCalledTimes(2);
  });

  it('a double click sends once; identical props created anew, a re-render and a theme change do not open the lock again', async () => {
    const user = userEvent.setup();
    const onRoll = vi.fn();
    function Themed() {
      const { setTheme, setAccent } = useTheme();
      const [tick, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => { setTheme('light'); setAccent(ACCENTS[2].id); setTick(t => t + 1); }}>wechsel</button>
          <button type="button" onClick={() => setTick(t => t + 1)}>tick {tick}</button>
          <DiceTray expected={{ ...EXPECTED }} projection={JSON.parse(JSON.stringify(view(ROLL1))) as DiceProjection} onRoll={onRoll} onHold={vi.fn()} />
        </>
      );
    }
    render(<ThemeProvider><Themed /></ThemeProvider>);
    await user.dblClick(screen.getByRole('button', { name: 'Würfeln' }));
    expect(onRoll).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /^tick/ }));
    await user.click(screen.getByRole('button', { name: 'wechsel' }));
    expect(document.documentElement.dataset.accent).toBe(ACCENTS[2].id);
    const locked = screen.getByRole('button', { name: 'Gesendet' });
    expect(locked).toHaveAttribute('aria-disabled', 'true');
    expect(locked).not.toBeDisabled(); // the lock must NOT use `disabled`: a focused control that becomes disabled loses keyboard focus (measured in Chromium, N9 review)
    await user.click(locked);
    expect(onRoll).toHaveBeenCalledTimes(1);
    expect(dieButtons().every(b => b.getAttribute('aria-disabled') === 'true')).toBe(true); // the holds of THIS binding are locked as well
  });

  it('roll and hold share ONE intent per binding: a roll right after a hold click, and a hold right after a roll click, send nothing second', async () => {
    const user = userEvent.setup();
    const onRoll = vi.fn(), onHold = vi.fn();
    mount({ onRoll, onHold });
    await user.click(dieButtons()[0]);
    expect(dieButtons()[0]).toHaveFocus(); // the pressed die keeps keyboard focus while its binding is locked
    expect(dieButtons().some(b => (b as HTMLButtonElement).disabled)).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Gesendet' }));
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onRoll).not.toHaveBeenCalled();
    cleanup();
    const onRoll2 = vi.fn(), onHold2 = vi.fn();
    mount({ onRoll: onRoll2, onHold: onHold2 });
    await user.click(screen.getByRole('button', { name: 'Würfeln' }));
    await user.click(dieButtons()[0]);
    await user.click(dieButtons()[4]);
    expect(onRoll2).toHaveBeenCalledTimes(1);
    expect(onHold2).not.toHaveBeenCalled();
  });

  it('a NEW projection (another binding) frees the controls; a repeat of the same binding does not; a late ACK or late failure of an OLD binding changes neither', async () => {
    const user = userEvent.setup();
    const oldRoll = deferred();
    const onRoll = vi.fn(() => oldRoll.promise);
    const newHold = deferred();
    const onHold = vi.fn(() => newHold.promise);
    const { set } = mount({ projection: view(PREPARED), onRoll, onHold });
    await user.click(screen.getByRole('button', { name: 'Würfeln' })); // binding B1 (turn 1, dice version 0, roll 0)
    expect(onRoll).toHaveBeenCalledTimes(1);
    set({ projection: view(ROLL1) }); // the server's answer arrived: binding B2
    expect(dieButtons().every(b => b.getAttribute('aria-disabled') === null)).toBe(true); // B2 is free
    await user.click(dieButtons()[2]); // locks B2
    expect(onHold).toHaveBeenCalledTimes(1);
    // the late failure of B1 must not unlock B2
    await act(async () => { oldRoll.reject(new Error('late')); await Promise.resolve(); });
    expect(dieButtons().every(b => b.getAttribute('aria-disabled') === 'true')).toBe(true);
    await user.click(dieButtons()[0]);
    expect(onHold).toHaveBeenCalledTimes(1);
    // a refusal of the CURRENT binding frees exactly this binding for a retry
    await act(async () => { newHold.reject(new Error('refused')); await Promise.resolve(); });
    expect(dieButtons().every(b => b.getAttribute('aria-disabled') === null)).toBe(true);
    await user.click(dieButtons()[0]);
    expect(onHold).toHaveBeenCalledTimes(2);
  });

  it('a successful answer without a new projection does not unlock (the lock belongs to the binding, not to the promise); a synchronous throw unlocks and rethrows', async () => {
    const user = userEvent.setup();
    const onRoll = vi.fn(() => Promise.resolve('ACK'));
    mount({ onRoll });
    await user.click(screen.getByRole('button', { name: 'Würfeln' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Gesendet' })).toHaveAttribute('aria-disabled', 'true');
    cleanup();
    const boom = vi.fn(() => { throw new Error('sync'); });
    mount({ onRoll: boom });
    const swallow = (event: ErrorEvent) => event.preventDefault(); // React reports the rethrown error of an event handler as a window error; this test expects it
    window.addEventListener('error', swallow);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try { await act(async () => { screen.getByRole('button', { name: 'Würfeln' }).click(); }); } finally { errors.mockRestore(); window.removeEventListener('error', swallow); }
    expect(boom).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Würfeln' })).not.toHaveAttribute('aria-disabled');
  });

  it('never calls a callback by itself: mount, StrictMode, re-renders, new props objects, timers, theme changes, an arriving projection and a reload', async () => {
    vi.useFakeTimers();
    const onRoll = vi.fn(), onHold = vi.fn();
    const { set, unmount } = mount({ projection: view(PREPARED), onRoll, onHold });
    set({ projection: view(ROLL1) });
    set({ projection: JSON.parse(JSON.stringify(view(ROLL1))) as DiceProjection });
    set({ projection: view({ ...ROLL1, dv: 2, state: 7 }, { held: [true, false, false, false, false] }) });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    unmount();
    render(<StrictMode><DiceTray expected={EXPECTED} projection={view(ROLL1)} onRoll={onRoll} onHold={onHold} /></StrictMode>);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(onRoll).not.toHaveBeenCalled();
    expect(onHold).not.toHaveBeenCalled();
  });
});

describe('N9 DiceTray: ordering, withdrawal and the required chains in the real component', () => {
  const shown = () => screen.queryByRole('status')?.textContent ?? '';

  it('new roll → null → older roll: after the withdrawal the older roll does not come back, no action is offered', () => {
    const onRoll = vi.fn();
    const { set } = mount({ projection: view({ ...ROLL1, roll: 2, dv: 3, state: 8 }, { values: [6, 6, 6, 6, 6] }), onRoll });
    expect(shown()).toContain('Wurf 2 von 3: 6, 6, 6, 6, 6.');
    set({ projection: null });
    expect(screen.getByText('Die Würfel sind zurzeit nicht verfügbar.')).toBeInTheDocument();
    set({ projection: view({ ...ROLL1, state: 7, dv: 2 }, { values: [1, 1, 1, 1, 1] }) });
    expect(shown()).toBe('');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    set({ projection: view({ ...ROLL1, roll: 2, dv: 3, state: 9 }, { values: [6, 6, 6, 6, 6] }) }); // a newer stand is shown again
    expect(shown()).toContain('6, 6, 6, 6, 6');
  });

  it('closed → invalid → old active view: nothing actionable comes back', () => {
    const { set } = mount({ projection: view({ ...ROLL1, state: 9, dv: 4, roll: 2 }, { closed: true, values: [2, 2, 2, 2, 2] }), onRoll: vi.fn(), onHold: vi.fn() });
    expect(shown()).toContain('Beendet.');
    set({ projection: { nonsense: true } as unknown as DiceProjection });
    expect(screen.getByText('Die Würfel sind zurzeit nicht verfügbar.')).toBeInTheDocument();
    set({ projection: view({ ...ROLL1, state: 7, dv: 2 }) });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(shown()).toBe('');
  });

  it('A turn 1 → B turn 2 → A turn 3 → a late packet of A\'s turn 1: A is NOT offered the old dice or the old binding again', async () => {
    const user = userEvent.setup();
    const onRoll = vi.fn();
    const turn1 = view({ state: 5, seq: 2, turn: 1, dv: 1, roll: 1 }, { values: [1, 1, 1, 1, 1] });
    const { set } = mount({ projection: turn1, onRoll });
    set({ projection: view({ state: 7, seq: 3, turn: 2, dv: 0, roll: 0 }, { holder: 'p2' }) });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    set({ projection: view({ state: 9, seq: 4, turn: 3, dv: 0, roll: 0 }) }); // A again, a new process
    expect(shown()).toBe('Noch nicht gewürfelt.');
    set({ projection: turn1 }); // the late packet
    expect(shown()).toBe('Noch nicht gewürfelt.');
    expect(text()).not.toContain('1, 1, 1, 1, 1');
    await user.click(screen.getByRole('button', { name: 'Würfeln' }));
    expect(onRoll).toHaveBeenCalledWith(origin(3, { sequenceVersion: 4, diceVersion: 0, rollCount: 0 })); // the binding of TURN 3
  });

  it('a packet made for A rendered under B\'s expectation shows nothing — also in a team; the right recipient shows it', () => {
    const forA = view(ROLL1, { unit: 'TEAM', recipient: 'A', holder: 'A', values: [3, 3, 3, 3, 3] });
    mount({ expected: { ...EXPECTED, unit: 'TEAM', recipientId: 'B' }, projection: forA, onRoll: vi.fn() });
    expect(screen.getByText('Die Würfel sind zurzeit nicht verfügbar.')).toBeInTheDocument();
    expect(text()).not.toContain('3, 3, 3');
    cleanup();
    mount({ expected: { ...EXPECTED, unit: 'TEAM', recipientId: 'A' }, projection: forA, onRoll: vi.fn() });
    expect(shown()).toContain('3, 3, 3, 3, 3');
  });

  it('same turn, new N8 basis stand: the same dice and the remaining rolls stay on screen; the OLD action binding is not offered again, the new one is', async () => {
    const user = userEvent.setup();
    const onRoll = vi.fn();
    const before = view({ state: 6, seq: 3, turn: 2, dv: 2, roll: 1 }, { values: [2, 4, 6, 1, 3] });
    const after = view({ state: 7, seq: 4, turn: 2, dv: 2, roll: 1 }, { values: [2, 4, 6, 1, 3] });
    const { set } = mount({ projection: before, onRoll });
    set({ projection: after });
    expect(shown()).toBe('Wurf 1 von 3: 2, 4, 6, 1, 3.');
    expect(screen.getByText('1 von 3')).toBeInTheDocument();
    set({ projection: before }); // the old binding arrives late
    expect(shown()).toBe('Wurf 1 von 3: 2, 4, 6, 1, 3.');
    await user.click(screen.getByRole('button', { name: 'Würfeln' }));
    expect(onRoll).toHaveBeenCalledWith(origin(2, { sequenceVersion: 4, diceVersion: 2, rollCount: 1 }));
  });
});

describe('N9 DiceTray: animation is decoration only', () => {
  const tumbling = () => screen.queryAllByRole('listitem').flatMap((li, index) => (li.querySelector('[data-tumble="true"]') !== null ? [index] : []));

  it('a stand that is seen for the first time (mount, reload, rejoin) is shown without motion; a NEW roll tumbles exactly the dice of that roll', () => {
    const first = mount({ projection: view({ ...ROLL1, roll: 2, dv: 3 }, { values: [1, 2, 3, 4, 5] }) });
    expect(tumbling()).toEqual([]);
    first.unmount();
    const again = mount({ projection: view({ ...ROLL1, roll: 2, dv: 3 }, { values: [1, 2, 3, 4, 5] }) }); // a reload shows the stored roll, it does not roll again
    expect(tumbling()).toEqual([]);
    again.set({ projection: view({ ...ROLL1, roll: 3, dv: 5, state: 8 }, { values: [1, 6, 3, 4, 6] }) });
    expect(tumbling()).toEqual([0, 2]); // the positions of the last roll
    expect(shown()).toContain('1, 6, 3, 4, 6');
  });

  const shown = () => screen.queryByRole('status')?.textContent ?? '';

  it('holding does not re-roll the animation; a withdrawal and a late older packet change nothing; an animationend event has no effect at all', async () => {
    const onRoll = vi.fn(), onHold = vi.fn();
    const { set } = mount({ projection: view(PREPARED), onRoll, onHold });
    set({ projection: view(ROLL1, { values: [1, 2, 3, 4, 5] }) });
    expect(tumbling()).toEqual([0, 1, 2, 3, 4]);
    const before = document.body.innerHTML;
    for (const li of screen.getAllByRole('listitem')) fireEvent.animationEnd(li.firstElementChild as Element);
    fireEvent.animationEnd(screen.getByRole('status'));
    expect(document.body.innerHTML).toBe(before); // a (late) animation callback is not part of the contract: nothing reacts to it
    expect(onRoll).not.toHaveBeenCalled();
    expect(onHold).not.toHaveBeenCalled();
    set({ projection: view({ ...ROLL1, dv: 2, state: 7 }, { held: [true, false, false, false, false], values: [1, 2, 3, 4, 5] }) });
    expect(tumbling()).toEqual([0, 1, 2, 3, 4]); // still the marker of roll 1; no second animation was started by a hold
    set({ projection: null });
    set({ projection: view({ ...ROLL1, dv: 1 }, { values: [9 % 7, 2, 3, 4, 5] }) }); // an older packet
    expect(shown()).toBe('');
  });

  it('a newer projection that arrives while an animation is running shows ITS values at once — the old animation can neither overwrite nor unlock it', async () => {
    const user = userEvent.setup();
    const onHold = vi.fn(), onRoll = vi.fn();
    const { set } = mount({ projection: view(PREPARED), onRoll, onHold });
    set({ projection: view(ROLL1, { values: [1, 1, 1, 1, 1] }) });
    set({ projection: view({ ...ROLL1, roll: 2, dv: 2, state: 7 }, { values: [1, 6, 1, 6, 1] }) });
    expect(shown()).toBe('Wurf 2 von 3: 1, 6, 1, 6, 1.');
    expect(tumbling()).toEqual([0, 2]);
    await user.click(dieButtons()[1]);
    expect(onHold).toHaveBeenCalledWith(expect.objectContaining({ diceVersion: 2, rollCount: 2, held: [1] }));
  });

  it('contains no timer, no animation callback and no random digit anywhere, and switches the motion off for prefers-reduced-motion', () => {
    const code = readFileSync(resolve(process.cwd(), 'src/components/DiceTray.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const forbidden = /setTimeout|setInterval|requestAnimationFrame|onAnimationEnd|animationend|Math\.random|Date\.now|localStorage/;
    expect(code).not.toMatch(forbidden);
    expect('el.addEventListener("animationend", cb); setTimeout(cb, 1)').toMatch(forbidden); // positive control: the probe sees them
    const css = readFileSync(resolve(process.cwd(), 'src/components/DiceTray.module.css'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.tumble\s*\{\s*animation: none;/);
    expect(css).not.toMatch(/animation-iteration-count:\s*infinite|\binfinite\b/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/); // Midnight tokens only: theme and accent switch through the variables
    expect(css).not.toMatch(/box-shadow|text-shadow|blur\(/); // no glow
  });

  it('renders the same text under every accent and both themes (tokens switch, markup does not)', () => {
    const projection = view(ROLL1, { held: [false, true, false, false, false] });
    const markup = renderToStaticMarkup(<ThemeProvider><DiceTray expected={EXPECTED} projection={projection} onRoll={() => undefined} onHold={() => undefined} /></ThemeProvider>);
    expect(markup).toContain('aria-pressed="true"');
    function Switcher() {
      const { setTheme, setAccent } = useTheme();
      return (<button type="button" onClick={() => { setTheme('light'); setAccent(ACCENTS[ACCENTS.length - 1].id); }}>wechsel</button>);
    }
    render(<ThemeProvider><Switcher /><DiceTray expected={EXPECTED} projection={projection} onRoll={() => undefined} onHold={() => undefined} /></ThemeProvider>);
    const before = screen.getByRole('list', { name: 'Würfel' }).textContent;
    act(() => { screen.getByRole('button', { name: 'wechsel' }).click(); });
    expect(screen.getByRole('list', { name: 'Würfel' }).textContent).toBe(before);
    expect(document.documentElement.dataset.accent).toBe(ACCENTS[ACCENTS.length - 1].id);
  });
});
