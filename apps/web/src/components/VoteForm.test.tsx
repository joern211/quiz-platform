import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { ThemeProvider, useTheme, ACCENTS } from '@quiz/ui';
import { votingAbstainBallot, votingOptionBallot, type VotingBallot, type VotingOptionsConfig } from '@quiz/shared/voting';
import { describe, expect, it, vi } from 'vitest';
import { VoteForm, type VoteFeedback, type VoteFormProps } from './VoteForm';

// Synthetic fixture: ids and labels are NOT game presets and carry no author, role or "real/fake" meaning.
const options = [
  { optionId: 'aa', label: 'Alpha', help: 'Erste Hilfe' },
  { optionId: 'bb', label: 'Beta', help: null },
  { optionId: 'cc', label: 'Gleich', help: null },
  { optionId: 'dd', label: 'Gleich', help: null },
];
const config: VotingOptionsConfig = { schemaVersion: 1, prompt: 'Wähle eine Option.', options };
const ALL = ['aa', 'bb', 'cc', 'dd'];
const CTX = 'run1:round1:poll1';
const opt = (id: string): VotingBallot => votingOptionBallot(id);
const abst = (): VotingBallot => votingAbstainBallot();

function mount(props: Partial<VoteFormProps> = {}) {
  const onSubmit = vi.fn();
  const base: VoteFormProps = { title: 'Deine Stimme', config, selectableOptionIds: ALL, allowAbstain: false, contextKey: CTX, onSubmit, ...props };
  const view = render(<VoteForm {...base} />);
  return { onSubmit, view, base, set: (next: Partial<VoteFormProps>) => view.rerender(<VoteForm {...base} {...next} />) };
}
const radios = () => screen.getAllByRole('radio') as HTMLInputElement[];
const radio = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}`) }) as HTMLInputElement;
const checkedIds = () => radios().filter(r => r.checked).map(r => r.value);
const send = () => screen.getByRole('button', { name: /^(Stimme abgeben|Erneut senden)$/ });

describe('N4 VoteForm: group, options and selection', () => {
  it('is a labelled native radio group with nothing pre-selected, the public texts and exactly one submit button', () => {
    mount();
    const group = screen.getByRole('group', { name: 'Wähle eine Option.' });
    expect(group.tagName).toBe('FIELDSET');
    expect(screen.getByRole('heading', { name: 'Deine Stimme' })).toBeInTheDocument();
    expect(screen.getByText('Erste Hilfe')).toBeInTheDocument();
    expect(radios()).toHaveLength(4);
    expect(checkedIds()).toEqual([]); // the first option is NOT chosen for the voter
    expect(radios().every(r => r.type === 'radio' && !r.disabled)).toBe(true);
    expect(send()).toHaveAttribute('type', 'submit');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(document.querySelectorAll('form form')).toHaveLength(0);
    expect(screen.getByRole('group')).toHaveAccessibleDescription(/verbindlich und kann nicht geändert werden/);
  });
  it('falls back to a neutral legend when the config has no prompt', () => {
    mount({ config: { ...config, prompt: null } });
    expect(screen.getByRole('group', { name: 'Deine Stimme' })).toBeInTheDocument();
  });
  it('selects by click without sending anything; exactly one option is selected at a time', async () => {
    const { onSubmit } = mount();
    await userEvent.click(radio('Alpha'));
    expect(checkedIds()).toEqual(['aa']);
    await userEvent.click(radio('Beta'));
    expect(checkedIds()).toEqual(['bb']);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('also selects by clicking the label text (touch-sized hit area is the whole row)', async () => {
    mount();
    await userEvent.click(screen.getByText('Beta'));
    expect(checkedIds()).toEqual(['bb']);
  });
  it('keeps equal labels apart: names carry the position, the choice is by option id', async () => {
    const { onSubmit } = mount();
    const gleich = screen.getAllByRole('radio', { name: /^Gleich/ });
    expect(gleich.map(r => r.getAttribute('value'))).toEqual(['cc', 'dd']);
    expect(gleich[0]).toHaveAccessibleName('Gleich, Option 3 von 4');
    expect(gleich[1]).toHaveAccessibleName('Gleich, Option 4 von 4');
    await userEvent.click(gleich[1]);
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(opt('dd'), `${CTX}#1`);
  });
  it('arrow keys and Space change the selection only — they never send; tab order is one stop for the group', async () => {
    const { onSubmit } = mount();
    await userEvent.tab();
    expect(radios()[0]).toHaveFocus(); // first stop, nothing chosen yet
    await userEvent.keyboard('{ArrowDown}');
    expect(checkedIds()).toEqual(['bb']);
    await userEvent.keyboard('{ArrowDown}');
    expect(checkedIds()).toEqual(['cc']);
    await userEvent.keyboard('{ArrowUp}');
    expect(checkedIds()).toEqual(['bb']);
    await userEvent.keyboard(' ');
    expect(checkedIds()).toEqual(['bb']);
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(send()).toHaveFocus(); // the group is ONE tab stop
  });
  it('Enter on a radio never sends the binding vote; Enter or Space on the focused button does, exactly once', async () => {
    const { onSubmit } = mount();
    radio('Alpha').focus();
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.click(radio('Beta'));
    radio('Beta').focus();
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    send().focus();
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(opt('bb'), `${CTX}#1`);
  });
  it('Space on the focused button sends as well', async () => {
    const { onSubmit } = mount();
    await userEvent.click(radio('Alpha'));
    send().focus();
    await userEvent.keyboard(' ');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
  it('an empty selection shows an error and moves the focus to the first radio — nothing is sent, nothing becomes an abstention', async () => {
    const { onSubmit } = mount({ allowAbstain: true });
    await userEvent.click(send());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Bitte wähle eine Option oder enthalte dich bewusst');
    expect(radios()[0]).toHaveFocus();
    expect(checkedIds()).toEqual([]);
    expect(send()).toBeEnabled();
    await userEvent.click(radio('Beta'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // changing the selection clears the hint
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(opt('bb'), `${CTX}#1`);
  });
  it('an empty selection focuses the first CHOOSABLE radio when the first option is not allowed', async () => {
    mount({ selectableOptionIds: ['bb', 'cc'] });
    await userEvent.click(send());
    expect(radio('Beta')).toHaveFocus();
  });
  it('sends a fresh, complete ballot object once per attempt (no alias to later state)', async () => {
    const { onSubmit, set } = mount();
    await userEvent.click(radio('Alpha'));
    await userEvent.click(send());
    const sent = onSubmit.mock.calls[0][0] as VotingBallot;
    const snapshot = JSON.stringify(sent);
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'ERROR', retryable: true } });
    await userEvent.click(radio('Beta'));
    expect(JSON.stringify(sent)).toBe(snapshot);
    expect(sent).toEqual({ schemaVersion: 1, kind: 'OPTION', optionId: 'aa' });
  });
});

describe('N4 VoteForm: own choice list and explicit abstention', () => {
  it('only the voter\'s own choosable ids can be chosen; the others are shown disabled and can neither be clicked nor sent', async () => {
    const { onSubmit } = mount({ selectableOptionIds: ['aa', 'cc'] });
    expect(radio('Alpha')).toBeEnabled();
    expect(radio('Beta')).toBeDisabled();
    expect(screen.getAllByRole('radio', { name: /^Gleich/ }).map(r => (r as HTMLInputElement).disabled)).toEqual([false, true]);
    expect(screen.getByText('Beta').closest('label')).toHaveTextContent('Diese Option kannst du nicht wählen.');
    await userEvent.click(radio('Beta'));
    expect(checkedIds()).toEqual([]);
    await userEvent.click(radio('Alpha'));
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(opt('aa'), `${CTX}#1`);
  });
  it('has no abstention radio unless the voter may abstain, and no implicit abstention either way', async () => {
    const a = mount();
    expect(screen.queryByRole('radio', { name: /Enthalten/ })).not.toBeInTheDocument();
    a.view.unmount();
    const b = mount({ allowAbstain: true });
    expect(screen.getByRole('radio', { name: /^Enthalten/ })).toBeInTheDocument();
    expect(radios()).toHaveLength(5);
    expect(checkedIds()).toEqual([]); // not chosen = not chosen
    await userEvent.click(send());
    expect(b.onSubmit).not.toHaveBeenCalled();
  });
  it('sends an explicit abstention as its own ballot kind, only after a deliberate choice', async () => {
    const { onSubmit } = mount({ allowAbstain: true });
    await userEvent.click(screen.getByRole('radio', { name: /^Enthalten/ }));
    expect((screen.getByRole('radio', { name: /^Enthalten/ }) as HTMLInputElement).checked).toBe(true);
    expect(radios().filter(r => r.checked)).toHaveLength(1);
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith({ schemaVersion: 1, kind: 'ABSTAIN' }, `${CTX}#1`);
    expect('optionId' in (onSubmit.mock.calls[0][0] as object)).toBe(false);
  });
  it('an abstention can be replaced by an option before sending (one group, one choice)', async () => {
    const { onSubmit } = mount({ allowAbstain: true });
    await userEvent.click(screen.getByRole('radio', { name: /^Enthalten/ }));
    await userEvent.click(radio('Beta'));
    expect(checkedIds()).toEqual(['bb']);
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(opt('bb'), `${CTX}#1`);
  });
  it('a voter who may only abstain gets the abstention choice and no option can be chosen', async () => {
    const { onSubmit } = mount({ selectableOptionIds: [], allowAbstain: true });
    expect(radios().filter(r => !r.disabled)).toHaveLength(1);
    await userEvent.click(screen.getByRole('radio', { name: /^Enthalten/ }));
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith({ schemaVersion: 1, kind: 'ABSTAIN' }, `${CTX}#1`);
  });
  it('a voter with nothing to choose and no abstention right gets a message and no form', () => {
    const { onSubmit } = mount({ selectableOptionIds: [], allowAbstain: false });
    expect(screen.getByRole('status')).toHaveTextContent('keine Auswahl möglich');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('N4 VoteForm: invalid or leaking props are not rendered', () => {
  const blocked = (props: Partial<VoteFormProps>) => {
    const { view, onSubmit } = mount(props);
    expect(screen.getByRole('alert')).toHaveTextContent('Die Abstimmung kann nicht angezeigt werden.');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    view.unmount();
  };
  it('refuses unknown, duplicate and mistyped choosable ids and a non-boolean abstention right', () => {
    blocked({ selectableOptionIds: ['aa', 'zz'] });
    blocked({ selectableOptionIds: ['aa', 'aa'] });
    blocked({ selectableOptionIds: ['aa', 7 as unknown as string] });
    blocked({ selectableOptionIds: 'aa' as unknown as string[] });
    blocked({ allowAbstain: undefined as unknown as boolean });
  });
  it('refuses a config that carries more than the public fields (author, correctness, role, solution, voters)', () => {
    for (const extra of ['authorId', 'solution', 'voters', 'allowedOptionIds', 'seed']) blocked({ config: { ...config, [extra]: 'x' } as unknown as VotingOptionsConfig });
    blocked({ config: { ...config, options: [{ ...options[0], isCorrect: true }, ...options.slice(1)] } as unknown as VotingOptionsConfig });
    blocked({ config: { ...config, options: [options[0]] } });
    blocked({ config: { ...config, options: [options[0], options[0]] } });
    blocked({ config: null as unknown as VotingOptionsConfig });
  });
});

describe('N4 VoteForm: attempt contract (N1-R1 on the real component)', () => {
  const r1 = 'run1:round1:poll1', r2 = 'run1:round2:poll1', p2 = 'run1:round1:poll2';
  const pick = async (name: string) => userEvent.click(radio(name));

  it('locks at once: double click and a late PENDING never send a second time; selection and button are disabled meanwhile', async () => {
    const { onSubmit, set } = mount();
    await pick('Alpha');
    await userEvent.dblClick(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(send()).toBeDisabled();
    expect(radios().every(r => r.disabled)).toBe(true);
    await userEvent.click(radio('Beta'));
    expect(checkedIds()).toEqual(['aa']);
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'PENDING' } });
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
  it('moves the focus to the status line when the form freezes; after a retryable error to the retry button; never later', async () => {
    const { set } = mount();
    await pick('Alpha');
    send().focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('status')).toHaveFocus();
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'ERROR', retryable: true, message: 'Netzwerk' } });
    expect(screen.getByRole('button', { name: 'Erneut senden' })).toHaveFocus();
    expect(checkedIds()).toEqual(['aa']);
  });
  it('does not steal the focus on parent re-renders', async () => {
    function Page() {
      const [n, setN] = useState(0);
      return (<>
        <button type="button" onClick={() => setN(n + 1)}>neu rendern</button>
        <input aria-label="Woanders" />
        <VoteForm config={config} selectableOptionIds={ALL} allowAbstain={false} contextKey="c" onSubmit={() => {}} />
      </>);
    }
    render(<Page />);
    await userEvent.click(radio('Alpha'));
    screen.getByLabelText('Woanders').focus();
    await userEvent.click(screen.getByRole('button', { name: 'neu rendern' }));
    screen.getByLabelText('Woanders').focus();
    await userEvent.keyboard('x');
    expect(screen.getByLabelText('Woanders')).toHaveFocus();
    expect(checkedIds()).toEqual(['aa']);
  });
  it('works with a parent that answers synchronously from inside onSubmit', async () => {
    function Parent() {
      const [fb, setFb] = useState<VoteFeedback | null>(null);
      return <VoteForm config={config} selectableOptionIds={ALL} allowAbstain contextKey="c" onSubmit={(ballot, attemptId) => setFb({ contextKey: 'c', attemptId, status: 'SUBMITTED', ballot })} feedback={fb} />;
    }
    render(<Parent />);
    await userEvent.click(radio('Beta'));
    await userEvent.click(send());
    expect(screen.getByRole('status')).toHaveTextContent('Stimme abgegeben.');
    expect(checkedIds()).toEqual(['bb']);
  });
  it('R1-A: an old-round ACK does not remove the new round\'s pending state or lock', async () => {
    const { onSubmit, set } = mount();
    await pick('Alpha');
    await userEvent.click(send());
    set({ contextKey: r2 });
    await pick('Beta');
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenLastCalledWith(opt('bb'), `${r2}#2`);
    set({ contextKey: r2, feedback: { contextKey: r2, attemptId: `${r2}#2`, status: 'PENDING' } });
    expect(send()).toBeDisabled();
    set({ contextKey: r2, feedback: { contextKey: r1, attemptId: `${r1}#1`, status: 'SUBMITTED', ballot: opt('aa') } });
    expect(checkedIds()).toEqual(['bb']);
    expect(send()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
  });
  it('R1-B: an old-round ACK does not allow a second submission of the new round', async () => {
    const { onSubmit, set } = mount();
    await pick('Alpha');
    await userEvent.click(send());
    set({ contextKey: r2 });
    await pick('Alpha');
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(2);
    set({ contextKey: r2, feedback: { contextKey: r1, attemptId: `${r1}#1`, status: 'SUBMITTED', ballot: opt('aa') } });
    await userEvent.click(send());
    send().focus();
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
  it('R1-C: the same retry error as a NEW object is no answer; the same error echoing the NEW attempt is', async () => {
    const error = (attemptId: string): VoteFeedback => ({ contextKey: r1, attemptId, status: 'ERROR', retryable: true, message: 'Bitte erneut versuchen.' });
    const { onSubmit, set } = mount({ feedback: error(`${r1}#0`) });
    await pick('Beta');
    await userEvent.click(send()); // attempt #1
    expect(onSubmit).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i++) set({ feedback: error(`${r1}#0`) }); // re-created, content-identical object
    expect(send()).toBeDisabled();
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    set({ feedback: error(`${r1}#1`) }); // a real answer to attempt 1
    expect(send()).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Bitte erneut versuchen.');
    expect(checkedIds()).toEqual(['bb']); // selection kept
    await userEvent.click(send()); // manual retry = attempt #2
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith(opt('bb'), `${r1}#2`);
    set({ feedback: error(`${r1}#1`) }); // identical error of the OLD attempt: still no answer to #2
    expect(send()).toBeDisabled();
    set({ feedback: error(`${r1}#2`) }); // identical error for the NEW attempt: a real answer
    expect(send()).toBeEnabled();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(onSubmit).toHaveBeenCalledTimes(2); // no automatic resend, ever
  });
  it('a retryable error keeps the selection editable; a fatal error makes everything read-only and disabled', async () => {
    const a = mount();
    await pick('Alpha');
    await userEvent.click(send());
    a.set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'ERROR', retryable: true, message: 'Netzwerk' } });
    expect(radios().every(r => !r.disabled)).toBe(true);
    await userEvent.click(radio('Beta'));
    expect(checkedIds()).toEqual(['bb']);
    expect(screen.getByRole('button', { name: 'Erneut senden' })).toBeEnabled();
    a.view.unmount();
    const b = mount();
    await pick('Alpha');
    await userEvent.click(send());
    b.set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'ERROR', retryable: false, message: 'Die Zeit ist abgelaufen.' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Die Zeit ist abgelaufen.');
    expect(send()).toBeDisabled();
    expect(radios().every(r => r.disabled)).toBe(true);
    expect(checkedIds()).toEqual(['aa']);
    expect(b.onSubmit).toHaveBeenCalledTimes(1);
  });
  it('null, missing and unattached feedback is "no information" and never unlocks', async () => {
    const { set } = mount();
    await pick('Alpha');
    await userEvent.click(send());
    set({ feedback: null });
    set({ feedback: undefined });
    set({ feedback: { contextKey: 'run9:other', attemptId: null, status: 'ERROR', retryable: true } });
    set({ feedback: { contextKey: CTX, status: 'ERROR', retryable: true } as unknown as VoteFeedback });
    expect(send()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
  });
  it('ignores feedback of an older attempt, then processes the matching one normally; never regresses within an attempt', async () => {
    const { set } = mount();
    await pick('Alpha');
    await userEvent.click(send());
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'ERROR', retryable: true, message: 'x' } });
    await userEvent.click(send()); // #2
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'SUBMITTED', ballot: opt('dd') } }); // older: ignored
    expect(screen.queryByText('Stimme abgegeben.')).not.toBeInTheDocument();
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#2`, status: 'SUBMITTED', ballot: opt('aa') } }); // the current ACK after an ignored old one
    expect(screen.getByRole('status')).toHaveTextContent('Stimme abgegeben.');
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#2`, status: 'PENDING' } });
    expect(screen.getByRole('status')).toHaveTextContent('Stimme abgegeben.');
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#2`, status: 'ERROR', retryable: true } });
    expect(screen.getByRole('status')).toHaveTextContent('Stimme abgegeben.');
  });
  it('a second poll of the SAME round (new contextKey) drops selection, held feedback AND the confirmation; old ACKs stay ignored', async () => {
    const { onSubmit, set } = mount({ allowAbstain: true });
    await pick('Alpha');
    await userEvent.click(send());
    set({ feedback: { contextKey: r1, attemptId: `${r1}#1`, status: 'SUBMITTED', ballot: opt('aa') } });
    expect(screen.getByRole('status')).toHaveTextContent('Stimme abgegeben.');
    set({ contextKey: p2, feedback: { contextKey: r1, attemptId: `${r1}#1`, status: 'SUBMITTED', ballot: opt('aa') } }); // stale ACK of poll 1
    expect(checkedIds()).toEqual([]);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(send()).toBeEnabled();
    await pick('Beta');
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenLastCalledWith(opt('bb'), `${p2}#2`);
    set({ contextKey: p2, feedback: { contextKey: r1, attemptId: `${r1}#1`, status: 'LOCKED', ballot: opt('aa') } });
    expect(checkedIds()).toEqual(['bb']);
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
    set({ contextKey: r1, feedback: null });
    expect(checkedIds()).toEqual([]); // coming back never resurrects it
  });
  it('the confirmation of poll 1 cannot reappear in poll 2: a lock WITHOUT data after the context change shows no old ballot', async () => {
    const { set } = mount({ allowAbstain: true });
    await pick('Alpha');
    await userEvent.click(send());
    set({ feedback: { contextKey: r1, attemptId: `${r1}#1`, status: 'SUBMITTED', ballot: opt('aa') } });
    expect(checkedIds()).toEqual(['aa']);
    set({ contextKey: p2, feedback: null });
    set({ contextKey: p2, feedback: { contextKey: p2, attemptId: null, status: 'LOCKED' } }); // the lock of the SECOND poll, no data
    expect(checkedIds()).toEqual([]); // not the old confirmed 'aa', and not an abstention either
    expect((screen.getByRole('radio', { name: /^Enthalten/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent('nicht als abgegebene Stimme bestätigt');
  });
  it('honours disabled without losing the selection', async () => {
    const { set, onSubmit } = mount();
    await pick('Alpha');
    set({ disabled: true });
    expect(send()).toBeDisabled();
    expect(radios().every(r => r.disabled)).toBe(true);
    expect(checkedIds()).toEqual(['aa']);
    set({ disabled: false });
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(opt('aa'), `${CTX}#1`);
  });
});

describe('N4 VoteForm: lock keeps the confirmed ballot and the attempt echo (N2-R1/R2 on the real component)', () => {
  const setup = (over: Partial<VoteFormProps> = {}) => {
    const onSubmit = vi.fn();
    const base: VoteFormProps = { config, selectableOptionIds: ALL, allowAbstain: true, contextKey: 'r', onSubmit, ...over };
    const view = render(<VoteForm {...base} />);
    const set = (feedback: VoteFeedback | null, next: Partial<VoteFormProps> = {}) => view.rerender(<VoteForm {...base} {...next} feedback={feedback} />);
    return { onSubmit, set };
  };
  /** Attempt r#1 is sent, an uncertain result allows a manual retry with a DIFFERENT local selection (r#2), and the server
   *  then confirms the ballot it had really accepted. UI attempt and server command are different things. */
  const confirmedAfterRetry = async (h: ReturnType<typeof setup>, accepted: VotingBallot = opt('cc')) => {
    await userEvent.click(radio('Alpha'));
    await userEvent.click(send());
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'ERROR', retryable: true });
    await userEvent.click(radio('Beta'));
    await userEvent.click(send());
    h.set({ contextKey: 'r', attemptId: 'r#2', status: 'SUBMITTED', ballot: accepted });
  };
  const lock = (): VoteFeedback => ({ contextKey: 'r', attemptId: null, status: 'LOCKED' });

  it('the confirmed ballot replaces a diverging local selection as soon as the server confirms it', async () => {
    const h = setup();
    await userEvent.click(radio('Alpha'));
    await userEvent.click(send());
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'SUBMITTED', ballot: opt('dd') });
    expect(checkedIds()).toEqual(['dd']);
    expect(screen.getByRole('status')).toHaveTextContent('Stimme abgegeben.');
  });
  it('R2: a current lock WITHOUT ballot data keeps the server-confirmed OPTION, not the local selection', async () => {
    const h = setup();
    await confirmedAfterRetry(h);
    expect(checkedIds()).toEqual(['cc']);
    h.set(lock());
    expect(checkedIds()).toEqual(['cc']);
    expect(screen.getByRole('status')).toHaveTextContent('Die Abstimmung ist geschlossen.');
    expect(screen.getByRole('status')).not.toHaveTextContent('nicht als abgegebene Stimme bestätigt');
    expect(send()).toBeDisabled();
    expect(radios().every(r => r.disabled)).toBe(true);
    expect(h.onSubmit).toHaveBeenCalledTimes(2);
  });
  it('R2: a confirmed ABSTENTION survives a status message without data (no truthy/falsy mix-up with "nothing confirmed")', async () => {
    const h = setup();
    await confirmedAfterRetry(h, abst());
    expect((screen.getByRole('radio', { name: /^Enthalten/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('Enthaltung abgegeben.');
    h.set(lock());
    expect((screen.getByRole('radio', { name: /^Enthalten/ }) as HTMLInputElement).checked).toBe(true);
    expect(checkedIds()).toEqual(['']); // the abstention radio has the empty value, no option is checked
    expect(screen.getByRole('status')).toHaveTextContent('Die Abstimmung ist geschlossen.');
    expect(screen.getByRole('status')).not.toHaveTextContent('nicht als abgegebene Stimme bestätigt');
    h.set({ contextKey: 'r', attemptId: 'r#2', status: 'LOCKED' }); // the current attempt's own lock echo, no data
    expect((screen.getByRole('radio', { name: /^Enthalten/ }) as HTMLInputElement).checked).toBe(true);
  });
  it('SUBMITTED without ballot data names what was actually sent: an abstention stays an abstention in the status line', async () => {
    const h = setup();
    await userEvent.click(screen.getByRole('radio', { name: /^Enthalten/ }));
    await userEvent.click(send());
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'SUBMITTED' });
    expect(screen.getByRole('status')).toHaveTextContent('Enthaltung abgegeben.');
    expect((screen.getByRole('radio', { name: /^Enthalten/ }) as HTMLInputElement).checked).toBe(true);
  });
  it('R1: an older attempt\'s LOCKED — with or without ballot — never changes the display, before or after the real lock', async () => {
    const h = setup();
    await confirmedAfterRetry(h);
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'LOCKED', ballot: opt('dd') });
    expect(checkedIds()).toEqual(['cc']);
    expect(screen.getByRole('status')).toHaveTextContent('Stimme abgegeben.'); // not even locked by a stale message
    h.set(lock());
    expect(screen.getByRole('status')).toHaveTextContent('geschlossen');
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'LOCKED', ballot: opt('dd') });
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'LOCKED' });
    h.set({ contextKey: 'r', attemptId: 'r#7', status: 'LOCKED', ballot: opt('dd') });
    expect(checkedIds()).toEqual(['cc']);
    expect(screen.getByRole('status')).toHaveTextContent('Die Abstimmung ist geschlossen.');
  });
  it('a lock without any confirmed ballot shows the local selection read-only and does NOT present it as a cast vote', async () => {
    const h = setup();
    await userEvent.click(radio('Alpha'));
    await userEvent.click(send());
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'PENDING' });
    h.set(lock());
    expect(checkedIds()).toEqual(['aa']);
    expect(screen.getByRole('status')).toHaveTextContent('nicht als abgegebene Stimme bestätigt');
    expect(screen.queryByText('Stimme abgegeben.')).not.toBeInTheDocument();
    expect(send()).toBeDisabled();
    expect(radios().every(r => r.disabled)).toBe(true);
  });
  it('locks before any submit: the (possibly empty) selection stays visible, nothing can be sent, an empty one stays empty', async () => {
    const a = setup();
    await userEvent.click(radio('Beta'));
    a.set(lock());
    expect(checkedIds()).toEqual(['bb']);
    expect(send()).toBeDisabled();
    await userEvent.click(send());
    expect(a.onSubmit).not.toHaveBeenCalled();
  });
  it('a lock on an untouched form selects nothing (no default, no abstention) and sends nothing', async () => {
    const h = setup();
    h.set(lock());
    expect(checkedIds()).toEqual([]);
    expect(screen.getByRole('status')).toHaveTextContent('nicht als abgegebene Stimme bestätigt');
    await userEvent.click(send());
    expect(h.onSubmit).not.toHaveBeenCalled();
  });
  it('LOCKED stays final and keeps the confirmed ballot: later PENDING/ERROR/SUBMITTED of any attempt change nothing', async () => {
    const h = setup();
    await confirmedAfterRetry(h);
    h.set(lock());
    for (const fb of [{ attemptId: 'r#2', status: 'PENDING' }, { attemptId: 'r#2', status: 'ERROR', retryable: true, message: 'zu spät' },
      { attemptId: 'r#2', status: 'SUBMITTED', ballot: opt('dd') }, { attemptId: null, status: 'SUBMITTED', ballot: opt('dd') }] as const) {
      h.set({ contextKey: 'r', ...fb });
      expect(checkedIds()).toEqual(['cc']);
      expect(screen.getByRole('status')).toHaveTextContent('geschlossen');
    }
    expect(screen.queryByText('zu spät')).not.toBeInTheDocument();
  });
  it('a lock whose attemptId property is missing still is the poll lock and keeps the confirmed ballot', async () => {
    const h = setup();
    await confirmedAfterRetry(h);
    h.set({ contextKey: 'r', status: 'LOCKED' } as unknown as VoteFeedback);
    expect(checkedIds()).toEqual(['cc']);
    expect(screen.getByRole('status')).toHaveTextContent('geschlossen');
  });
  it('an applicable lock WITH a ballot is authoritative and replaces the previously confirmed one', async () => {
    const h = setup();
    await confirmedAfterRetry(h);
    h.set({ contextKey: 'r', attemptId: null, status: 'LOCKED', ballot: opt('bb') });
    expect(checkedIds()).toEqual(['bb']);
    expect(screen.getByRole('status')).toHaveTextContent('geschlossen');
  });
  it('a "confirmed" ballot that is not valid for THIS voter (unknown option, forbidden abstention, option outside the own list) is neither shown nor held', async () => {
    const a = setup({ allowAbstain: false });
    await userEvent.click(radio('Alpha'));
    await userEvent.click(send());
    a.set({ contextKey: 'r', attemptId: 'r#1', status: 'SUBMITTED', ballot: abst() });
    expect(checkedIds()).toEqual(['aa']); // the abstention is not allowed for this voter: the draft stays visible, the held state is still SUBMITTED
    a.set({ contextKey: 'r', attemptId: 'r#1', status: 'SUBMITTED', ballot: { schemaVersion: 1, kind: 'OPTION', optionId: 'zz' } });
    expect(checkedIds()).toEqual(['aa']);
    a.set({ contextKey: 'r', attemptId: 'r#1', status: 'SUBMITTED', ballot: { schemaVersion: 1, kind: 'OPTION', optionId: 'bb', extra: 1 } as unknown as VotingBallot });
    expect(checkedIds()).toEqual(['aa']);
  });
  it('an option outside the voter\'s own list is not accepted as a confirmation either', async () => {
    const h = setup({ selectableOptionIds: ['aa', 'bb'] });
    await userEvent.click(radio('Alpha'));
    await userEvent.click(send());
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'SUBMITTED', ballot: opt('dd') }, { selectableOptionIds: ['aa', 'bb'] });
    expect(checkedIds()).toEqual(['aa']);
  });
});

describe('N4 VoteForm: identity, re-render, theme and changed configuration', () => {
  it('keeps the selection across parent re-renders with new but equal props objects, label changes and a metadata re-ordering of the same ids', async () => {
    const { set, onSubmit } = mount({ allowAbstain: true });
    await userEvent.click(radio('Beta'));
    set({ config: JSON.parse(JSON.stringify(config)) as VotingOptionsConfig, selectableOptionIds: [...ALL] });
    expect(checkedIds()).toEqual(['bb']);
    set({ config: { ...config, options: options.map(o => ({ ...o, label: `${o.label} neu` })) } });
    expect(checkedIds()).toEqual(['bb']);
    expect(radio('Beta neu')).toBeChecked();
    set({ config: { ...config, options: [options[3], options[1], options[0], options[2]] }, selectableOptionIds: ['dd', 'cc', 'bb', 'aa'] });
    expect(checkedIds()).toEqual(['bb']);
    expect(radios().map(r => r.value)).toEqual(['dd', 'bb', 'aa', 'cc', '']);
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(opt('bb'), `${CTX}#1`);
  });
  it('keeps an explicit abstention selection across re-renders as well', async () => {
    const { set } = mount({ allowAbstain: true });
    await userEvent.click(screen.getByRole('radio', { name: /^Enthalten/ }));
    set({ title: 'Anderer Titel' });
    expect((screen.getByRole('radio', { name: /^Enthalten/ }) as HTMLInputElement).checked).toBe(true);
  });
  function Harness({ onSubmit }: { onSubmit: VoteFormProps['onSubmit'] }) {
    const { setTheme, setAccent } = useTheme();
    return (
      <>
        <button type="button" onClick={() => setTheme('light')}>hell</button>
        <button type="button" onClick={() => setTheme('dark')}>dunkel</button>
        <button type="button" onClick={() => setAccent(ACCENTS[3].id)}>akzent</button>
        <VoteForm title="Deine Stimme" config={config} selectableOptionIds={ALL} allowAbstain contextKey="c" onSubmit={onSubmit} />
      </>
    );
  }
  it('keeps node identity, selection and the submission across theme and accent changes', async () => {
    const onSubmit = vi.fn();
    render(<ThemeProvider><Harness onSubmit={onSubmit} /></ThemeProvider>);
    await userEvent.click(radio('Alpha'));
    const node = radio('Alpha');
    for (const name of ['hell', 'akzent', 'dunkel']) await act(async () => { screen.getByRole('button', { name }).click(); });
    expect(document.documentElement.dataset.accent).toBe(ACCENTS[3].id);
    expect(radio('Alpha')).toBe(node);
    expect(checkedIds()).toEqual(['aa']);
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(opt('aa'), 'c#1');
  });
  it('a CHANGED option set under the SAME context is a contract violation: nothing rendered, nothing merged, nothing sent', async () => {
    const { onSubmit, set } = mount();
    await userEvent.click(radio('Alpha'));
    await userEvent.click(send());
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'SUBMITTED', ballot: opt('aa') } });
    const changed: VotingOptionsConfig = { ...config, options: [...options.slice(0, 3), { optionId: 'ee', label: 'Neu', help: null }] };
    set({ config: changed, selectableOptionIds: ['aa', 'bb', 'cc', 'ee'], feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'SUBMITTED', ballot: opt('aa') } });
    expect(screen.getByRole('alert')).toHaveTextContent('Die Abstimmung hat sich geändert');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(send()).toBeDisabled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // the proper way: a NEW context key resets everything and the new options work
    set({ config: changed, selectableOptionIds: ['aa', 'bb', 'cc', 'ee'], contextKey: 'run1:round1:poll9', feedback: null });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(radios().map(r => r.value)).toEqual(['aa', 'bb', 'cc', 'ee']);
    expect(checkedIds()).toEqual([]);
    await userEvent.click(radio('Neu'));
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenLastCalledWith(opt('ee'), 'run1:round1:poll9#2');
  });
  it('a changed choice list or abstention right under the SAME context is treated the same way — no silent late permission', async () => {
    const a = mount({ selectableOptionIds: ['aa', 'bb'] });
    await userEvent.click(radio('Alpha'));
    a.set({ selectableOptionIds: ['aa', 'bb', 'cc'] });
    expect(screen.getByRole('alert')).toHaveTextContent('hat sich geändert');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(send()).toBeDisabled();
    expect(a.onSubmit).not.toHaveBeenCalled();
    a.view.unmount();
    const b = mount({ allowAbstain: false });
    await userEvent.click(radio('Alpha'));
    b.set({ allowAbstain: true });
    expect(screen.getByRole('alert')).toHaveTextContent('hat sich geändert');
    expect(send()).toBeDisabled();
    expect(b.onSubmit).not.toHaveBeenCalled();
  });
  it('shows the smallest and the largest poll with long texts without breaking the form', async () => {
    const two = mount({ config: { ...config, options: options.slice(0, 2) }, selectableOptionIds: ['aa', 'bb'] });
    expect(radios()).toHaveLength(2);
    two.view.unmount();
    const long = Array.from({ length: 32 }, (_, i) => ({ optionId: `op${i}`, label: `Eine sehr lange Option, die in schmalen Fenstern umbrechen muss (${i + 1})`, help: 'Eine ebenso lange Hilfe, die das Layout nicht sprengen darf.' }));
    const { onSubmit } = mount({ config: { ...config, options: long }, selectableOptionIds: long.map(o => o.optionId), allowAbstain: true });
    expect(radios()).toHaveLength(33);
    await userEvent.click(radios()[31]);
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(opt('op31'), `${CTX}#1`);
  });
  it('exposes exactly one onSubmit per attempt across a whole flow (select, retry, confirm)', async () => {
    const { onSubmit, set } = mount({ allowAbstain: true });
    await userEvent.click(screen.getByRole('radio', { name: /^Enthalten/ }));
    await userEvent.click(send());
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'ERROR', retryable: true, message: 'Netzwerk' } });
    await userEvent.click(screen.getByRole('button', { name: 'Erneut senden' }));
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#2`, status: 'SUBMITTED', ballot: abst() } });
    expect(onSubmit.mock.calls).toEqual([[abst(), `${CTX}#1`], [abst(), `${CTX}#2`]]);
    expect(screen.getByRole('status')).toHaveTextContent('Enthaltung abgegeben.');
  });
});
