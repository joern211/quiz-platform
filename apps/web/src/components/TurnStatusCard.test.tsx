import { StrictMode, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme, ACCENTS } from '@quiz/ui';
import { TURN_SEQUENCE_CONTRACT, type TurnSequenceExpectedContext, type TurnSequenceProjection } from '@quiz/shared/turnSequence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnStatusCard } from './TurnStatusCard';

afterEach(() => { cleanup(); vi.useRealTimers(); });

// Synthetic fixtures: markers instead of game content.
const SCOPE = { runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'PLAYER' as const };
const EXPECTED: TurnSequenceExpectedContext = { ...SCOPE, recipientId: 'p1', minStateVersion: 1 };
interface Stand { state: number; seq: number; turn: number; ent?: number }
type Status = 'READY' | 'ACTIVE' | 'HELD' | 'NO_ELIGIBLE' | 'CLOSED';
const player = (stand: Stand, over: { holder?: string | null; status?: Status; release?: 'CURRENT' | 'ORDER'; you?: boolean } = {}): TurnSequenceProjection => {
  const holder = over.holder === undefined ? 'p1' : over.holder;
  const status = over.status ?? (holder === null ? 'NO_ELIGIBLE' : 'ACTIVE');
  const release = over.release ?? 'CURRENT';
  const shape = {
    contract: TURN_SEQUENCE_CONTRACT, scope: { ...SCOPE }, recipientId: over.you === false ? null : 'p1', stateVersion: stand.state, sequenceVersion: stand.seq, turnNumber: stand.turn, entitlementRevision: stand.ent ?? 1,
    release, status, current: holder === null ? null : { teamId: null, playerId: holder },
    you: over.you === false ? null : { holdsTurn: holder === 'p1', teamHoldsTurn: null, canAct: holder === 'p1' && status === 'ACTIVE' },
  };
  return (release === 'ORDER' ? { ...shape, order: { actorIds: ['p1', 'p2', 'p3'], position: holder === null ? null : ['p1', 'p2', 'p3'].indexOf(holder), cycle: 1 } } : shape) as TurnSequenceProjection;
};
const none = (stand: Stand): TurnSequenceProjection => ({ contract: TURN_SEQUENCE_CONTRACT, scope: { ...SCOPE }, recipientId: 'p1', stateVersion: stand.state, sequenceVersion: stand.seq, turnNumber: stand.turn, entitlementRevision: stand.ent ?? 1, release: 'NONE' });
const team = (over: { holdsTurn: boolean; teamHolds: boolean }): TurnSequenceProjection => ({
  contract: TURN_SEQUENCE_CONTRACT, scope: { ...SCOPE, unit: 'TEAM' }, recipientId: 'm9', stateVersion: 6, sequenceVersion: 4, turnNumber: 3, entitlementRevision: 1, release: 'CURRENT', status: 'ACTIVE',
  current: { teamId: 'T2', playerId: 'm9' }, you: { holdsTurn: over.holdsTurn, teamHoldsTurn: over.teamHolds, canAct: over.holdsTurn },
});
const TEAM_EXPECTED: TurnSequenceExpectedContext = { ...EXPECTED, unit: 'TEAM', recipientId: 'm9' };
const text = () => document.body.textContent ?? '';

function mount(over: { expected?: TurnSequenceExpectedContext; projection?: TurnSequenceProjection | null; names?: Record<string, string>; onAdvance?: (b: { turnNumber: number; sequenceVersion: number }) => void | Promise<unknown>; label?: string } = {}) {
  const base = { expected: EXPECTED, projection: player({ state: 5, seq: 3, turn: 2 }) as TurnSequenceProjection | null, ...over };
  // by default the card expects the recipient the fixture was made for (a packet without `you` belongs to a viewer-like recipient)
  if (over.expected === undefined && base.projection !== null && base.projection !== undefined && typeof base.projection === 'object') base.expected = { ...EXPECTED, recipientId: base.projection.recipientId };
  const view = render(<TurnStatusCard {...base} />);
  return { view, set: (next: typeof over) => view.rerender(<TurnStatusCard {...base} {...next} />) };
}

describe('N8 TurnStatusCard: what is shown', () => {
  it('shows each state as text, with the holder only when the server released one', () => {
    for (const [status, holder, expectedText] of [['READY', null, 'Noch nicht begonnen.'], ['ACTIVE', 'p2', 'Ein Zug läuft.'], ['HELD', 'p2', 'Der Zug ist angehalten.'], ['NO_ELIGIBLE', null, 'Niemand ist am Zug.'], ['CLOSED', null, 'Beendet.']] as const) {
      mount({ projection: player({ state: 5, seq: 3, turn: status === 'READY' ? 0 : 2 }, { status, holder, you: false }) });
      expect(screen.getByRole('status')).toHaveTextContent(expectedText);
      if (holder === null) expect(screen.queryByText('Am Zug')).not.toBeInTheDocument();
      else expect(screen.getByText('Am Zug')).toBeInTheDocument();
      cleanup();
    }
  });
  it('shows names from the caller\'s own mapping, falls back to the id, and names team AND responsible player in team mode', () => {
    mount({ projection: player({ state: 5, seq: 3, turn: 2 }, { holder: 'p2', you: false }), names: { p2: 'Mia Musterfrau' } });
    expect(screen.getByText('Mia Musterfrau')).toBeInTheDocument();
    cleanup();
    mount({ projection: player({ state: 5, seq: 3, turn: 2 }, { holder: 'p7', you: false }) });
    expect(screen.getByText('p7')).toBeInTheDocument();
    cleanup();
    mount({ expected: TEAM_EXPECTED, projection: team({ holdsTurn: false, teamHolds: false }), names: { T2: 'Rote Rakete', m9: 'Max' } });
    expect(screen.getByText('Team am Zug')).toBeInTheDocument();
    expect(screen.getByText('Rote Rakete')).toBeInTheDocument();
    expect(screen.getByText('Zuständig')).toBeInTheDocument();
    expect(screen.getByText('Max')).toBeInTheDocument();
  });
  it('shows the own hint only for the own view: holder, held holder, advising teammate — nothing for others', () => {
    mount({ projection: player({ state: 5, seq: 3, turn: 2 }) });
    expect(screen.getByText('Du bist am Zug.')).toBeInTheDocument();
    cleanup();
    mount({ projection: player({ state: 5, seq: 3, turn: 2 }, { status: 'HELD' }) });
    expect(screen.getByText('Dein Zug ist angehalten.')).toBeInTheDocument();
    expect(screen.queryByText('Du bist am Zug.')).not.toBeInTheDocument();
    cleanup();
    mount({ expected: TEAM_EXPECTED, projection: team({ holdsTurn: false, teamHolds: true }) });
    expect(screen.getByText('Dein Team ist am Zug. Du kannst beraten.')).toBeInTheDocument();
    cleanup();
    mount({ projection: player({ state: 5, seq: 3, turn: 2 }, { holder: 'p2', you: false }) });
    expect(text()).not.toMatch(/Du bist|Dein Zug|Dein Team/);
  });
  it('shows the turn number always and the cycle and the order only with the order release (current entry marked as text)', () => {
    mount({ projection: player({ state: 5, seq: 3, turn: 7 }) });
    expect(screen.getByText('Zug')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByText('Umlauf')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Reihenfolge' })).not.toBeInTheDocument();
    cleanup();
    mount({ projection: player({ state: 5, seq: 3, turn: 7 }, { holder: 'p2', release: 'ORDER', you: false }), names: { p1: 'Ada', p2: 'Bo', p3: 'Cy' } });
    expect(screen.getByText('Umlauf')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument(); // cycle 1 → "Umlauf 2"
    const items = screen.getAllByRole('listitem').map(item => item.textContent);
    expect(items).toEqual(['Ada', 'Bo (am Zug)', 'Cy']);
  });
  it('shows a neutral text — and nothing of the other data — for no projection, a withdrawn release, a foreign or an invalid one', () => {
    const secret = player({ state: 5, seq: 3, turn: 2 }, { holder: 'p-secret' });
    for (const [name, props] of [
      ['null', { projection: null }], ['undefined', { projection: undefined as never }], ['release NONE', { projection: none({ state: 5, seq: 3, turn: 2 }) }],
      ['foreign run', { projection: { ...secret, scope: { ...SCOPE, runIndex: 9 } } }], ['foreign sequence', { projection: { ...secret, scope: { ...SCOPE, sequenceId: 'x' } } }],
      ['below the independent minimum', { expected: { ...EXPECTED, minStateVersion: 9 }, projection: secret }],
      ['invalid shape', { projection: { ...secret, extra: true } as never }], ['garbage', { projection: 'x' as never }],
    ] as const) {
      mount(props as never);
      expect(text(), name).toContain('Der Zugstatus ist zurzeit nicht verfügbar.');
      expect(text(), name).not.toContain('p-secret');
      expect(screen.queryByRole('status'), name).not.toBeInTheDocument();
      expect(screen.queryByRole('button'), name).not.toBeInTheDocument();
      cleanup();
    }
  });
  it('renders a foreign or stale projection not even for one frame (static first render, no effects)', () => {
    const secret = player({ state: 5, seq: 3, turn: 2 }, { holder: 'p-secret' });
    for (const markup of [
      renderToStaticMarkup(<TurnStatusCard expected={EXPECTED} projection={{ ...secret, scope: { ...SCOPE, sequenceId: 'other' } }} />),
      renderToStaticMarkup(<TurnStatusCard expected={{ ...EXPECTED, recipientId: 'p2', minStateVersion: 9 }} projection={secret} />),
      renderToStaticMarkup(<TurnStatusCard expected={EXPECTED} projection={null} />),
    ]) { expect(markup).not.toContain('p-secret'); expect(markup).toContain('zurzeit nicht verfügbar'); }
    expect(renderToStaticMarkup(<TurnStatusCard expected={EXPECTED} projection={secret} />)).toContain('p-secret');
  });
  it('keeps long names unclipped in the text (layout itself is only checked in the browser harness)', () => {
    const long = 'Ein sehr langer Teamname '.repeat(6) + 'Donaudampfschifffahrtsgesellschaftskapitänsmütze';
    mount({ expected: TEAM_EXPECTED, projection: team({ holdsTurn: false, teamHolds: false }), names: { T2: long, m9: long + ' Spieler' }, label: long });
    expect(screen.getAllByText(long).length).toBeGreaterThan(0);
    expect(screen.getByText(long + ' Spieler')).toBeInTheDocument();
  });
  it('has an accessible name from its heading and a polite status region', () => {
    mount({ label: 'Reihenfolge der Runde' });
    expect(screen.getByRole('region', { name: 'Reihenfolge der Runde' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

describe('N8 TurnStatusCard: ordering — an old view never restores a holder or an action', () => {
  /** A card driven by buttons, so projections arrive like they would from a socket: in any order, also late. */
  function Driven({ onAdvance }: { onAdvance: (b: { turnNumber: number; sequenceVersion: number }) => void }) {
    const [payload, setPayload] = useState<TurnSequenceProjection | null>(player({ state: 10, seq: 10, turn: 9, ent: 1 }));
    return (
      <>
        <button type="button" onClick={() => setPayload(player({ state: 10, seq: 10, turn: 9, ent: 1 }))}>turn9</button>
        <button type="button" onClick={() => setPayload(player({ state: 9, seq: 9, turn: 8, ent: 1 }))}>turn8</button>
        <button type="button" onClick={() => setPayload(player({ state: 11, seq: 11, turn: 9, ent: 2 }, { status: 'HELD' }))}>held</button>
        <button type="button" onClick={() => setPayload(null)}>withdraw</button>
        <button type="button" onClick={() => setPayload(none({ state: 12, seq: 12, turn: 10, ent: 3 }))}>none12</button>
        <button type="button" onClick={() => setPayload(player({ state: 13, seq: 13, turn: 11, ent: 3 }, { holder: 'p2' }))}>b11</button>
        <button type="button" onClick={() => setPayload(player({ state: 14, seq: 14, turn: 12, ent: 3 }))}>a12</button>
        <TurnStatusCard expected={EXPECTED} projection={payload} onAdvance={onAdvance} />
      </>
    );
  }
  const press = async (name: string) => { await act(async () => { screen.getByRole('button', { name }).click(); }); };

  it('turn 9 → null → old turn 8: nothing and no action come back', async () => {
    render(<Driven onAdvance={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Zug beenden' })).toBeInTheDocument();
    await press('withdraw');
    expect(text()).toContain('nicht verfügbar');
    await press('turn8');
    expect(text()).toContain('nicht verfügbar');
    expect(screen.queryByRole('button', { name: 'Zug beenden' })).not.toBeInTheDocument();
    await press('turn9'); // even the very packet that was shown before is below the knowledge only if older; the same stand is accepted again
    expect(screen.queryByRole('button', { name: 'Zug beenden' })).toBeInTheDocument();
  });
  it('a newer lock is not undone by the older "active" view; the action stays withdrawn', async () => {
    render(<Driven onAdvance={vi.fn()} />);
    await press('held');
    expect(screen.getByRole('status')).toHaveTextContent('Der Zug ist angehalten.');
    expect(screen.queryByRole('button', { name: 'Zug beenden' })).not.toBeInTheDocument();
    await press('turn9');
    expect(screen.getByRole('status')).toHaveTextContent('Der Zug ist angehalten.');
    expect(screen.queryByRole('button', { name: 'Zug beenden' })).not.toBeInTheDocument();
    await press('withdraw');
    await press('turn9');
    expect(text()).toContain('nicht verfügbar');
    expect(screen.queryByRole('button', { name: 'Zug beenden' })).not.toBeInTheDocument();
  });
  it('a newer view without a holder raises the knowledge: the older action does not return after it (turn 9 → none v12 → turn 9)', async () => {
    render(<Driven onAdvance={vi.fn()} />);
    await press('none12');
    expect(text()).toContain('nicht verfügbar');
    await press('turn9');
    expect(screen.queryByRole('button', { name: 'Zug beenden' })).not.toBeInTheDocument();
    await press('b11');
    expect(screen.queryByRole('button', { name: 'Zug beenden' })).not.toBeInTheDocument(); // v13 > v12 is accepted, but p2 holds the turn
    expect(screen.getByText('p2')).toBeInTheDocument();
  });
});

describe('N8 TurnStatusCard: the action is bound to the shown turn', () => {
  it('is offered only to the holder who may act: not for a viewer, a held turn, a teammate, other players or a missing callback', () => {
    const onAdvance = vi.fn();
    for (const props of [
      { projection: player({ state: 5, seq: 3, turn: 2 }, { you: false }) }, { projection: player({ state: 5, seq: 3, turn: 2 }, { status: 'HELD' }) },
      { projection: player({ state: 5, seq: 3, turn: 2 }, { holder: 'p2' }) }, { expected: TEAM_EXPECTED, projection: team({ holdsTurn: false, teamHolds: true }) },
      { projection: none({ state: 5, seq: 3, turn: 2 }) },
    ]) { mount({ onAdvance, ...props } as never); expect(screen.queryByRole('button')).not.toBeInTheDocument(); cleanup(); }
    mount({ onAdvance: undefined });
    expect(screen.queryByRole('button')).not.toBeInTheDocument(); // no callback → no action
    cleanup();
    mount({ onAdvance });
    expect(screen.getByRole('button', { name: 'Zug beenden' })).toBeEnabled();
    expect(onAdvance).not.toHaveBeenCalled();
  });
  it('a press calls the callback once with the binding of the SHOWN turn and locks it; a second press, new equal props objects and a re-render change nothing', async () => {
    const onAdvance = vi.fn();
    const { set } = mount({ onAdvance });
    const button = screen.getByRole('button', { name: 'Zug beenden' });
    await userEvent.click(button);
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(onAdvance).toHaveBeenCalledWith({ turnNumber: 2, sequenceVersion: 3 });
    expect(screen.getByRole('button', { name: 'Gesendet' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Gesendet' }));
    set({ expected: { ...EXPECTED }, projection: JSON.parse(JSON.stringify(player({ state: 5, seq: 3, turn: 2 }))) as TurnSequenceProjection, onAdvance });
    set({ label: 'Neu gelabelt', onAdvance });
    set({ onAdvance: (b) => onAdvance(b) }); // a new callback identity too
    expect(screen.getByRole('button', { name: 'Gesendet' })).toBeDisabled(); // the lock survived: it is keyed by the binding, not by object identity
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });
  it('a duplicate delivery of the same stand keeps the lock; the next turn of the SAME player is another binding with its own button', async () => {
    const onAdvance = vi.fn();
    const { set } = mount({ onAdvance });
    await userEvent.click(screen.getByRole('button', { name: 'Zug beenden' }));
    set({ projection: player({ state: 5, seq: 3, turn: 2 }), onAdvance });
    expect(screen.getByRole('button', { name: 'Gesendet' })).toBeDisabled();
    set({ projection: player({ state: 6, seq: 4, turn: 3 }, { holder: 'p2' }), onAdvance }); // B's turn: no action for A
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    set({ projection: player({ state: 7, seq: 5, turn: 4 }), onAdvance }); // A again: a NEW turn
    const again = screen.getByRole('button', { name: 'Zug beenden' });
    expect(again).toBeEnabled();
    await userEvent.click(again);
    expect(onAdvance.mock.calls.map(call => call[0])).toEqual([{ turnNumber: 2, sequenceVersion: 3 }, { turnNumber: 4, sequenceVersion: 5 }]);
    // an OLD binding is never re-sent: a late packet of turn 2 shows nothing new and the lock of turn 4 stays
    set({ projection: player({ state: 5, seq: 3, turn: 2 }), onAdvance });
    expect(screen.getByRole('button', { name: 'Gesendet' })).toBeDisabled();
    expect(onAdvance).toHaveBeenCalledTimes(2);
  });
  it('a rejected send unlocks the SAME binding for a retry; a resolved one stays locked until a newer stand arrives', async () => {
    const onAdvance = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined);
    mount({ onAdvance });
    await userEvent.click(screen.getByRole('button', { name: 'Zug beenden' }));
    await act(async () => { await Promise.resolve(); });
    const retry = screen.getByRole('button', { name: 'Zug beenden' });
    expect(retry).toBeEnabled();
    await userEvent.click(retry);
    await act(async () => { await Promise.resolve(); });
    expect(onAdvance).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Gesendet' })).toBeDisabled();
  });
  it('works from the keyboard exactly once per binding (Enter, then Space on the disabled button does nothing)', async () => {
    const onAdvance = vi.fn();
    mount({ onAdvance });
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Zug beenden' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{Enter}');
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });
  it('never calls the callback by itself: mount, StrictMode, re-renders, new props objects, timers and theme changes', async () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    function Themed() {
      const { setTheme, setAccent } = useTheme();
      const [tick, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => { setTheme('light'); setAccent(ACCENTS[2].id); setTick(t => t + 1); }}>wechsel</button>
          <button type="button" onClick={() => setTick(t => t + 1)}>tick {tick}</button>
          <StrictMode><TurnStatusCard expected={{ ...EXPECTED }} projection={JSON.parse(JSON.stringify(player({ state: 5, seq: 3, turn: 2 }))) as TurnSequenceProjection} onAdvance={onAdvance} /></StrictMode>
        </>
      );
    }
    render(<ThemeProvider><Themed /></ThemeProvider>);
    const node = screen.getByRole('status');
    for (let i = 0; i < 5; i++) { await act(async () => { vi.advanceTimersByTime(1000); screen.getByRole('button', { name: /^tick/ }).click(); }); }
    await act(async () => { screen.getByRole('button', { name: 'wechsel' }).click(); });
    expect(document.documentElement.dataset.accent).toBe(ACCENTS[2].id);
    expect(screen.getByRole('status')).toBe(node); // the same DOM node: no remount from the re-renders and the theme change
    expect(screen.getByRole('button', { name: 'Zug beenden' })).toBeEnabled();
    expect(onAdvance).not.toHaveBeenCalled();
    cleanup();
    mount({ onAdvance }); // a fresh mount of the same data does not send either
    expect(onAdvance).not.toHaveBeenCalled();
  });
  it('a context switch drops everything of the old context: another recipient sees the neutral text and no lock leaks over', async () => {
    const onAdvance = vi.fn();
    const { set } = mount({ onAdvance });
    await userEvent.click(screen.getByRole('button', { name: 'Zug beenden' }));
    set({ expected: { ...EXPECTED, recipientId: 'p2' }, projection: player({ state: 5, seq: 3, turn: 2 }, { holder: 'p1', you: false }), onAdvance });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    set({ expected: EXPECTED, projection: player({ state: 5, seq: 3, turn: 2 }), onAdvance });
    expect(screen.getByRole('button', { name: 'Gesendet' })).toBeDisabled(); // the same binding in the same context is still sent
    set({ expected: { ...EXPECTED, sequenceId: 'seq-2' }, projection: { ...player({ state: 5, seq: 3, turn: 2 }), scope: { ...SCOPE, sequenceId: 'seq-2' } }, onAdvance });
    expect(screen.getByRole('button', { name: 'Zug beenden' })).toBeEnabled(); // another sequence: another binding space
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });
});

describe('N8 TurnStatusCard: recipient binding (PR #38 review N8-01)', () => {
  const forRecipient = (recipient: string | null, holder: string, stand: Stand = { state: 5, seq: 3, turn: 2 }): TurnSequenceProjection => {
    const base = player(stand, { holder, you: recipient !== null });
    return recipient === null ? base : { ...base, recipientId: recipient, you: { holdsTurn: holder === recipient, teamHoldsTurn: null, canAct: holder === recipient } } as TurnSequenceProjection;
  };
  const as = (recipient: string | null): TurnSequenceExpectedContext => ({ ...EXPECTED, recipientId: recipient });
  const show = (expected: TurnSequenceExpectedContext, projection: TurnSequenceProjection | null, onAdvance = vi.fn()) => ({ onAdvance, ...render(<TurnStatusCard expected={expected} projection={projection} onAdvance={onAdvance} />) });

  it('Alice → Bob with Alice\'s packet still present: no foreign "you", no action, neutral text — and no frame of it (static first render)', () => {
    const alice = forRecipient('alice', 'alice');
    const { onAdvance, rerender } = show(as('alice'), alice);
    expect(screen.getByRole('button', { name: 'Zug beenden' })).toBeInTheDocument();
    rerender(<TurnStatusCard expected={as('bob')} projection={alice} onAdvance={onAdvance} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(text()).not.toContain('Du bist am Zug.');
    expect(text()).toContain('nicht verfügbar');
    expect(renderToStaticMarkup(<TurnStatusCard expected={as('bob')} projection={alice} onAdvance={onAdvance} />)).not.toContain('Zug beenden');
    expect(onAdvance).not.toHaveBeenCalled();
  });
  it('a late Alice packet after Bob\'s own valid view neither hands Bob an action nor keeps Alice\'s; Bob\'s own packet is shown again at once', () => {
    const bob = forRecipient('bob', 'bob');
    const { rerender, onAdvance } = show(as('bob'), bob);
    expect(screen.getByRole('button', { name: 'Zug beenden' })).toBeEnabled();
    rerender(<TurnStatusCard expected={as('bob')} projection={forRecipient('alice', 'alice', { state: 9, seq: 9, turn: 9 })} onAdvance={onAdvance} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(text()).not.toMatch(/Du bist am Zug|Zug\s*9/);
    rerender(<TurnStatusCard expected={as('bob')} projection={bob} onAdvance={onAdvance} />); // not poisoned by version 9
    expect(screen.getByRole('button', { name: 'Zug beenden' })).toBeEnabled();
  });
  it('the send lock of Alice does not carry over to Bob, even for the SAME turn binding; Bob\'s own press is his own', async () => {
    const onAdvance = vi.fn();
    const { rerender } = show(as('alice'), forRecipient('alice', 'alice'), onAdvance);
    await userEvent.click(screen.getByRole('button', { name: 'Zug beenden' }));
    expect(onAdvance).toHaveBeenCalledTimes(1);
    rerender(<TurnStatusCard expected={as('bob')} projection={forRecipient('bob', 'bob')} onAdvance={onAdvance} />);
    const bobs = screen.getByRole('button', { name: 'Zug beenden' });
    expect(bobs).toBeEnabled(); // another recipient: another context, another lock
    await userEvent.click(bobs);
    expect(onAdvance).toHaveBeenCalledTimes(2);
  });
  it('two members of one team stay apart: the advising teammate never gets the holder\'s action', () => {
    const teamPacket = (recipient: string, holds: boolean): TurnSequenceProjection => ({ ...team({ holdsTurn: holds, teamHolds: true }), recipientId: recipient });
    const expected = (recipient: string): TurnSequenceExpectedContext => ({ ...TEAM_EXPECTED, recipientId: recipient });
    const onAdvance = vi.fn();
    const { rerender } = show(expected('m9'), teamPacket('m9', true), onAdvance);
    expect(screen.getByRole('button', { name: 'Zug beenden' })).toBeInTheDocument();
    rerender(<TurnStatusCard expected={expected('m8')} projection={teamPacket('m9', true)} onAdvance={onAdvance} />); // teammate m8 receives m9's packet
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<TurnStatusCard expected={expected('m8')} projection={teamPacket('m8', false)} onAdvance={onAdvance} />);
    expect(screen.getByText('Dein Team ist am Zug. Du kannst beraten.')).toBeInTheDocument(); // advising is shown, but it is not responsibility
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('viewer / display (recipient null) get no action from a packet that carries somebody\'s "you"; a playing host acts only for his own id', () => {
    const { onAdvance, rerender } = show(as(null), forRecipient('alice', 'alice'));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(text()).toContain('nicht verfügbar');
    rerender(<TurnStatusCard expected={as(null)} projection={forRecipient(null, 'alice')} onAdvance={onAdvance} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Ein Zug läuft.'); // its own, released view
    rerender(<TurnStatusCard expected={as('host-1')} projection={forRecipient('host-1', 'host-1')} onAdvance={onAdvance} />);
    expect(screen.getByRole('button', { name: 'Zug beenden' })).toBeInTheDocument();
    rerender(<TurnStatusCard expected={as('host-1')} projection={forRecipient(null, 'host-1')} onAdvance={onAdvance} />); // the host's non-player packet is no player packet
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('the same valid projection of the same recipient keeps its view and DOM nodes without a reset (equal packet in a new object)', () => {
    const bob = forRecipient('bob', 'bob');
    const { rerender, onAdvance } = show(as('bob'), bob);
    const node = screen.getByRole('status');
    rerender(<TurnStatusCard expected={{ ...as('bob') }} projection={JSON.parse(JSON.stringify(bob)) as TurnSequenceProjection} onAdvance={onAdvance} />);
    expect(screen.getByRole('status')).toBe(node);
    expect(screen.getByRole('button', { name: 'Zug beenden' })).toBeEnabled();
  });
});
