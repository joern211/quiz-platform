import { describe, expect, it } from 'vitest';
import { createCommandIntentClient, type CommandEmitter } from '@quiz/shared';

/** The browser adapter wraps exactly this client; these cases fix its intent lifecycle. */
function harness() {
  const client = createCommandIntentClient(), sent: Array<{ id: string; ack: (response: unknown) => void }> = [];
  const wire: CommandEmitter = { emit: (_event, data, ack) => { sent.push({ id: (data as { commandId: string }).commandId, ack }); } };
  return { client, sent, send: (key = 'k') => client.emitCommand(wire, 'e', {}, key) };
}

describe('intent lifecycle: an identity is kept until the outcome is clear', () => {
  it('uses a fresh id after a definitive success or a definitive refusal', () => {
    const h = harness();
    h.send(); h.sent[0].ack({ success: true }); h.send();
    h.sent[1].ack({ success: false, error: 'PHASE_NOT_BUZZ_OPEN' }); h.send();
    expect(new Set(h.sent.map(s => s.id)).size).toBe(3);
  });

  it.each([
    ['in progress', { success: false, error: 'COMMAND_IN_PROGRESS' }],
    ['outcome unknown', { success: false, outcomeUnknown: true, error: 'INTERNAL_ERROR' }],
    ['provisional refusal by the request protection', { success: false, error: 'RATE_LIMITED', code: 'RATE_LIMITED', retryable: true, details: { retryAfterMs: 120 } }],
  ])('keeps the id after %s, so a retry can only be answered from a stored receipt', (_name, response) => {
    const h = harness();
    h.send(); h.sent[0].ack(response); h.send(); h.sent[1].ack(response); h.send();
    expect(new Set(h.sent.map(s => s.id)).size).toBe(1);
    h.sent[2].ack({ success: true, replayed: true }); h.send(); // clarified: the next intent is a new one
    expect(h.sent[3].id).not.toBe(h.sent[0].id);
  });

  it('does not let a late acknowledgement of an older send delete a newer intent', () => {
    const h = harness();
    h.send(); const first = h.sent[0];
    h.client.discardIntentToken('k');                 // an explicit new user intent for the same key
    h.send(); const second = h.sent[1];
    expect(second.id).not.toBe(first.id);
    first.ack({ success: true });                      // the old acknowledgement arrives late
    h.send();
    expect(h.sent[2].id).toBe(second.id);              // the newer intent kept its identity
  });

  it('ignores malformed acknowledgements without consuming the intent', () => {
    const h = harness();
    h.send(); h.sent[0].ack(null); h.sent[0].ack({ error: 'x' }); h.send();
    expect(h.sent[1].id).toBe(h.sent[0].id);
  });
});
