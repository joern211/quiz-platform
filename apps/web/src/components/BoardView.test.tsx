import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from '@quiz/ui';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BoardExpectedContext, BoardMoveIntent, BoardProjection } from '@quiz/shared/board';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardView, type BoardMoveAttempt } from './BoardView';
import { EXPECTED, OFFERED, SCOPE, T1, view } from '../board/boardTestFixtures';

afterEach(() => { cleanup(); });

const text = () => document.body.textContent ?? '';
const deferred = () => { let resolve!: (v?: unknown) => void, reject!: (e?: unknown) => void; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const ROLL3 = T1({ state: 6, bv: 0, roll: { dv: 1, count: 1, steps: 3 } });
const mineView = (stand = ROLL3, over: Parameters<typeof view>[1] = {}) => view(stand, { targets: OFFERED, ...over });

interface Mount { expected?: BoardExpectedContext; projection?: BoardProjection | null; names?: Record<string, string>; onMove?: (i: BoardMoveIntent, a: BoardMoveAttempt) => void | Promise<unknown> }
function mount(over: Mount = {}) {
  const base = { expected: EXPECTED, projection: mineView() as BoardProjection | null, ...over };
  if (over.expected === undefined && base.projection !== null && base.projection !== undefined) base.expected = { ...EXPECTED, recipientId: base.projection.recipientId };
  const utils = render(<BoardView {...base} />);
  return { ...utils, set: (next: Mount) => utils.rerender(<BoardView {...base} {...next} />) };
}
const figureButton = (id: string) => screen.getByRole('button', { name: new RegExp(`^Figur ${id}\\b`) });
const targetButton = (to: string) => screen.getByRole('button', { name: new RegExp(`^Nach Feld ${to}\\b`) });
const ORIGIN = { scope: { ...SCOPE }, boardId: 'board-1', turnNumber: 1, sequenceVersion: 2, boardVersion: 0, diceId: 'dice-t1', diceVersion: 1, rollCount: 1 };

describe('N11 BoardView: what is shown', () => {
  it('fields, figures and the roll as TEXT; an offered target is marked by words, not only by a frame', async () => {
    const user = userEvent.setup();
    mount({ onMove: vi.fn(), names: { p1: 'Anna', p2: 'Ben' } });
    expect(text()).toContain('Wurf: 3 Schritte.');
    expect(text()).toContain('Start von Anna');
    expect(text()).toContain('Ziel von Ben');
    expect(screen.getAllByRole('listitem').filter(li => /^Figur (a1|a2|b1|b2) \((Anna|Ben)\)$/.test(li.textContent ?? ''))).toHaveLength(4); // the figures on the fields (the picker buttons are no list items)
    expect(screen.queryByText('Mögliches Ziel')).not.toBeInTheDocument();
    await user.click(figureButton('a1'));
    expect(screen.getByText('Mögliches Ziel')).toBeInTheDocument();
    expect(screen.getByText(/Figur a1 \(Anna\), gewählt/)).toBeInTheDocument();
  });
  it('shows the last move including a capture, a spent roll, and no controls when nothing is offered', () => {
    mount({ projection: view(T1({ bv: 1, roll: { dv: 1, count: 1, steps: 3, spent: true } }), { at: { a1: 't3' }, lastMove: { figureId: 'a1', from: 'sa', to: 't3', captured: ['b1'], steps: 3, diceId: 'dice-t1', rollCount: 1, turnNumber: 1 } }), onMove: vi.fn() });
    expect(text()).toContain('Der Wurf (3 Schritte) ist verbraucht.');
    expect(text()).toContain('Figur a1 (p1) von sa nach t3, schlägt b1');
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });
  it('a withdrawn, foreign, empty (release NONE) or invalid projection never reaches the markup', () => {
    for (const projection of [null, undefined, view(T1(), { release: 'NONE' }), view(T1(), { boardId: 'board-2' }), view(T1(), { recipient: 'p2' }), { ...view(T1()), extra: 1 } as unknown as BoardProjection]) {
      const { container, unmount } = render(<BoardView expected={EXPECTED} projection={projection} onMove={vi.fn()} />);
      expect(container.textContent).toContain('Das Brett ist zurzeit nicht verfügbar.');
      expect(container.textContent).not.toContain('Figur');
      unmount();
    }
  });
  it('with a "no turn possible" roll the holder is told so and gets no controls', () => {
    mount({ projection: view(T1({ roll: { dv: 1, count: 1, steps: 6 } }), { targets: [] }), onMove: vi.fn() });
    expect(text()).toContain('mit diesem Wurf ist kein Zug möglich');
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });
});

describe('N11 BoardView: rights are not derived from the client', () => {
  it('a spectator, another player, the display and a view without onMove have NO controls — even if the packet is valid', () => {
    for (const [recipient, holder] of [['p2', 'p1'], [null, 'p1']] as const) {
      const { unmount } = mount({ projection: view(ROLL3, { recipient, holder }), onMove: vi.fn() });
      expect(screen.queryByRole('group')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      unmount();
    }
    mount({ projection: mineView() }); // the holder, but the application gave no callback
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('a packet whose targets claim a right the schema does not allow is dropped (a spectator packet with targets)', () => {
    const forged = { ...view(ROLL3, { recipient: null }), targets: OFFERED } as unknown as BoardProjection;
    const { container } = render(<BoardView expected={{ ...EXPECTED, recipientId: null }} projection={forged} onMove={vi.fn()} />);
    expect(container.textContent).toContain('zurzeit nicht verfügbar');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('N11 BoardView: choosing and sending', () => {
  it('figure, then one of ITS offered targets; the intent carries the complete origin of the SHOWN projection and nothing computed; nothing moves on screen', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    mount({ onMove });
    expect(onMove).not.toHaveBeenCalled(); // nothing on mount
    await user.click(figureButton('a2'));
    expect(screen.queryByRole('button', { name: /^Nach Feld t4/ })).not.toBeInTheDocument(); // only offered targets
    await user.click(targetButton('t3'));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][0]).toEqual({ ...ORIGIN, figureId: 'a2', to: 't3' });
    expect(onMove.mock.calls[0][1]).toEqual({ attemptId: 'a1' });
    expect(Object.keys(onMove.mock.calls[0][0]).sort()).toEqual(['boardId', 'boardVersion', 'diceId', 'diceVersion', 'figureId', 'rollCount', 'scope', 'sequenceVersion', 'to', 'turnNumber']);
    // no optimistic move: the figure still stands on its start field, the roll is not shown as spent, the last move is unchanged
    const startField = screen.getByText('Feld sa').closest('li') as HTMLElement;
    expect(startField.textContent).toContain('Figur a2');
    expect(text()).not.toContain('verbraucht');
  });
  it('a double click, and two ALTERNATIVE targets pressed in the same task, send ONE intent', async () => {
    const onMove = vi.fn();
    mount({ onMove, projection: view(ROLL3, { targets: [{ figureId: 'a1', to: 't3', captures: [] }, { figureId: 'a2', to: 't3', captures: [] }] }) });
    fireEvent.click(figureButton('a1'));
    const target = targetButton('t3');
    act(() => { target.click(); target.click(); });
    expect(onMove).toHaveBeenCalledTimes(1);
    // the other figure's controls share the lock of the binding
    fireEvent.click(figureButton('a2'));
    expect(onMove).toHaveBeenCalledTimes(1);
    // two alternatives of ONE figure in one task
    cleanup();
    const second = vi.fn();
    mount({ onMove: second, projection: view(T1({ roll: { dv: 1, count: 1, steps: 3 } }), { targets: [{ figureId: 'a1', to: 't3', captures: [] }, { figureId: 'a1', to: 't4', captures: [] }] }) });
    fireEvent.click(figureButton('a1'));
    const one = targetButton('t3'), two = targetButton('t4');
    act(() => { one.click(); two.click(); });
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0][0].to).toBe('t3');
  });
  it('the lock is aria-disabled (the focused control keeps its focus) and says so in words', async () => {
    const user = userEvent.setup();
    mount({ onMove: () => new Promise(() => undefined) });
    await user.click(figureButton('a1'));
    const target = targetButton('t3');
    target.focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(target);
    expect(target).toHaveAttribute('aria-disabled', 'true');
    expect(target).not.toBeDisabled();
    expect(text()).toContain('Der Zug wird gesendet');
  });
  it('works by keyboard alone', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    mount({ onMove });
    await user.tab();
    expect(document.activeElement).toBe(figureButton('a1'));
    await user.keyboard('{Enter}');
    await user.tab(); await user.tab();
    expect(document.activeElement).toBe(targetButton('t3'));
    await user.keyboard(' ');
    expect(onMove).toHaveBeenCalledTimes(1);
  });
});

describe('N11 BoardView: attempts, rejections and late answers', () => {
  async function send(user: ReturnType<typeof userEvent.setup>, figure = 'a1') { await user.click(figureButton(figure)); await user.click(targetButton('t3')); }
  it('retry after a rejection: the same binding is released, the retry is really sent, the user is told', async () => {
    const user = userEvent.setup();
    const first = deferred();
    const onMove = vi.fn().mockReturnValueOnce(first.promise).mockReturnValue(new Promise(() => undefined));
    mount({ onMove });
    await send(user);
    await act(async () => { first.reject(new Error('refused')); await first.promise.catch(() => undefined); });
    expect(text()).toContain('Der Zug wurde nicht angenommen');
    await user.click(figureButton('a1'));
    await user.click(targetButton('t3'));
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(onMove.mock.calls[1][1]).toEqual({ attemptId: 'a2' });
    expect(onMove.mock.calls[1][0]).toEqual(onMove.mock.calls[0][0]); // same intent, the application keeps ITS commandId
    expect(text()).not.toContain('Der Zug wurde nicht angenommen'); // a new attempt clears the old message
  });
  it('a LATE rejection of attempt 1 neither releases nor blocks the running retry (attempt 2) of the same binding', async () => {
    const user = userEvent.setup();
    const calls: Array<ReturnType<typeof deferred>> = [];
    const onMove = vi.fn((_intent: BoardMoveIntent, _attempt: BoardMoveAttempt) => { const d = deferred(); calls.push(d); return d.promise; });
    mount({ onMove });
    await send(user);
    await act(async () => { calls[0].reject(new Error('1')); await calls[0].promise.catch(() => undefined); });
    await user.click(figureButton('a1')); await user.click(targetButton('t3')); // attempt 2 in flight
    expect(onMove).toHaveBeenCalledTimes(2);
    await act(async () => { calls[0].reject(new Error('again')); }); // a second, late signal of attempt 1 (already settled) — must change nothing
    await user.click(figureButton('a1')); await user.click(targetButton('t3'));
    expect(onMove).toHaveBeenCalledTimes(2); // still locked by attempt 2
    await act(async () => { calls[1].reject(new Error('2')); await calls[1].promise.catch(() => undefined); });
    await user.click(figureButton('a1')); await user.click(targetButton('t3'));
    expect(onMove).toHaveBeenCalledTimes(3);
  });
  it('an old attempt of an OLD binding that is rejected late does not release the NEW binding\'s running attempt, and a late acceptance changes nothing', async () => {
    const user = userEvent.setup();
    const calls: Array<ReturnType<typeof deferred>> = [];
    const onMove = vi.fn((_intent: BoardMoveIntent, _attempt: BoardMoveAttempt) => { const d = deferred(); calls.push(d); return d.promise; });
    const utils = mount({ onMove });
    await send(user); // attempt 1 on binding X
    const next = mineView(T1({ state: 7, seq: 3, bv: 1, roll: { dv: 1, count: 1, steps: 3 } }), { at: { a1: 'sa' } }); // another binding (sequence + board version)
    utils.set({ projection: next, expected: { ...EXPECTED } });
    await user.click(figureButton('a2')); await user.click(targetButton('t3')); // attempt 2 on binding Y
    expect(onMove).toHaveBeenCalledTimes(2);
    await act(async () => { calls[0].reject(new Error('late 1')); await calls[0].promise.catch(() => undefined); });
    await user.click(figureButton('a2')); await user.click(targetButton('t3'));
    expect(onMove).toHaveBeenCalledTimes(2); // attempt 2 still holds binding Y
    expect(text()).not.toContain('Der Zug wurde nicht angenommen'); // the old attempt's message is not shown for the new binding
    await act(async () => { calls[1].resolve({ ok: true }); await calls[1].promise; }); // a late acceptance
    await user.click(figureButton('a2')); await user.click(targetButton('t3'));
    expect(onMove).toHaveBeenCalledTimes(2); // accepted stays locked until the projection moves on
  });
  it('a NEW projection (another board version) is another binding: free again, with its own origin', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn((_intent: BoardMoveIntent, _attempt: BoardMoveAttempt) => new Promise(() => undefined));
    const utils = mount({ onMove });
    await send(user);
    utils.set({ projection: mineView(T1({ state: 7, seq: 2, bv: 1, roll: { dv: 1, count: 2, steps: 3 } })) });
    await send(user);
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(onMove.mock.calls[1][0]).toMatchObject({ boardVersion: 1, rollCount: 2 });
  });
  it('new props objects, equal projections, re-renders and a theme change do not clear the lock and send nothing', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn((_intent: BoardMoveIntent, _attempt: BoardMoveAttempt) => new Promise(() => undefined));
    function Harness() {
      const { setTheme } = useTheme();
      return (<><button type="button" onClick={() => setTheme('dark')}>dark</button><BoardView expected={{ ...EXPECTED }} projection={JSON.parse(JSON.stringify(mineView()))} onMove={onMove} /></>);
    }
    render(<ThemeProvider><Harness /></ThemeProvider>);
    await send(user);
    await user.click(screen.getByRole('button', { name: 'dark' }));
    await user.click(figureButton('a1')); await user.click(targetButton('t3'));
    expect(onMove).toHaveBeenCalledTimes(1);
  });
  it('a foreign view, an EMPTY view and then an OLDER packet: the older packet is not shown, the floor is kept, and the current one gets its controls back', async () => {
    const onMove = vi.fn();
    const utils = mount({ onMove, projection: mineView(T1({ state: 8, bv: 2, roll: { dv: 1, count: 1, steps: 3 } })) });
    utils.set({ projection: view(T1({ state: 9 }), { boardId: 'board-2' }) });
    expect(text()).toContain('zurzeit nicht verfügbar');
    utils.set({ projection: view(T1({ state: 10, bv: 2 }), { release: 'NONE' }) });
    expect(text()).toContain('zurzeit nicht verfügbar');
    utils.set({ projection: mineView(T1({ state: 8, bv: 2, roll: { dv: 1, count: 1, steps: 3 } })) });
    expect(text()).toContain('zurzeit nicht verfügbar'); // older than the NONE view: not shown
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    utils.set({ projection: mineView(T1({ state: 11, bv: 2, roll: { dv: 1, count: 1, steps: 3 } })) });
    expect(screen.getByRole('button', { name: /^Figur a1/ })).toBeInTheDocument();
  });
  it('in StrictMode nothing is sent on mount either', () => {
    const onMove = vi.fn();
    render(<BoardView expected={EXPECTED} projection={mineView()} onMove={onMove} />, { reactStrictMode: true } as never);
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe('N11 BoardView: presentation', () => {
  it('uses Midnight tokens only, has no fixed widths, no motion and no glow in its stylesheet', () => {
    const css = readFileSync(resolve(__dirname, 'BoardView.module.css'), 'utf8');
    expect(css).not.toMatch(/animation|transition|@keyframes|box-shadow|text-shadow|filter:/);
    expect(css).not.toMatch(/(^|[;{\s])(width|min-width|max-width):\s*\d+px/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
  it('long names and many fields do not need any fixed layout (names wrap, the grid is auto-fill)', () => {
    const long = 'Ein sehr langer Name ohne Leerzeichen'.repeat(3).replace(/ /g, '');
    mount({ names: { p1: long, p2: long }, onMove: vi.fn() });
    expect(text()).toContain(long);
    const css = readFileSync(resolve(__dirname, 'BoardView.module.css'), 'utf8');
    expect(css).toContain('auto-fill');
    expect(css).toContain('overflow-wrap: anywhere');
  });
});
