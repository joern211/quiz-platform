import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createStateEvent, applyStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';

function snapshot(): EngineStateSnapshot { return { roomId: 'room', runIndex: 1, gameSlug: 'jeopardy', engineVersion: 1, stateVersion: 3,
  state: { phase: 'BUZZ_LOCKED', winner: 'alice', scores: { alice: 0 }, questions: ['SECRET'] } }; }
function metadata() { return { eventId: randomUUID(), type: 'JUDGE', commandId: 'intent', actorId: 'host', occurredAtMs: 100 }; }
it('replays a recorded decision without side effects and stores only changed state fields', () => {
  const before = snapshot(), after = { ...before.state, phase: 'FIELD_DONE', scores: { alice: 100 } };
  const event = createStateEvent(before, after, metadata());
  expect(event.changes.map(change => change.key)).toEqual(['phase', 'scores']);
  expect(JSON.stringify(event)).not.toContain('SECRET');
  expect(applyStateEvent(before, JSON.parse(JSON.stringify(event)))).toEqual({ ...before, stateVersion: 4, state: after });
  expect(before.state.scores).toEqual({ alice: 0 });
  expect(() => applyStateEvent(applyStateEvent(before, event), event)).toThrow('EVENT_VERSION_CONFLICT');
  expect(() => applyStateEvent({ ...before, roomId: 'other' }, event)).toThrow('EVENT_SCOPE_MISMATCH');
  expect(() => applyStateEvent({ ...before, runIndex: 2 }, event)).toThrow('EVENT_SCOPE_MISMATCH');
});
it('removes obsolete fields, supports explicit legacy checkpoints, and rejects unsafe keys', () => {
  const before = snapshot();
  const next = { phase: 'SELECTING', scores: { alice: 100 } };
  const event = createStateEvent(before, next, { ...metadata(), checkpoint: true });
  expect(applyStateEvent(before, event).state).toEqual(next);
  const delta = createStateEvent(before, next, metadata());
  expect(delta.removedKeys).toEqual(['winner', 'questions']);
  expect(applyStateEvent(before, delta).state).toEqual(next);
  expect(() => applyStateEvent(before, { ...delta, changes: [{ key: '__proto__', value: { polluted: true } }] })).toThrow('INVALID_STATE_EVENT');
  expect(() => applyStateEvent(before, { ...delta, stateVersion: 9 })).toThrow('INVALID_STATE_EVENT');
  expect(Object.prototype).not.toHaveProperty('polluted');
});
