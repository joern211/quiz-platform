import type { CoreBuzzer } from '@quiz/shared';

/**
 * Opaque identity of one concrete answer attempt: field/round scope, current
 * answer owner, the persisted claim time and the number of host corrections.
 * Re-assigning the buzzer winner (even back to the same person) or opening a new
 * field/round/stage yields a different id, so an older judgement cannot apply.
 * Derived from persisted state only; clients merely echo what the projection showed.
 */
export function answerAttemptId(scope: string, buzzer: Pick<CoreBuzzer, 'winnerId' | 'claimedAtMs' | 'overrides'> | null | undefined, fallbackWinnerId?: string | null): string | null {
  const owner = buzzer?.winnerId ?? fallbackWinnerId ?? null;
  return owner ? `${scope}|${owner}|${buzzer?.claimedAtMs ?? 0}|${buzzer?.overrides?.length ?? 0}` : null;
}

/** A modern client states which attempt it judged; legacy clients omit the field (documented boundary). */
export function assertCurrentAttempt(expected: string | null, provided: string | undefined): void {
  if (provided !== undefined && provided !== expected) throw new Error('STALE_ATTEMPT');
}
