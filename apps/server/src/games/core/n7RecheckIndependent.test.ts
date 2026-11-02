import { describe, expect, it } from 'vitest';
import { createRenewalIssuer } from './audioPlaybackPlan.js';

// Independent probe from the recheck at 84821b2, adapted to the guarantee that is actually given: the order across a restart needs the adapter to restore
// the last issued number (`last()` → `createRenewalIssuer(last)`); a bare clock is no persisted counter. The unconditional form of the probe stays
// reproducible as the DOCUMENTED LIMIT below.
describe('Independent N7 renewal issuer restart contract (recheck at 84821b2)', () => {
  it('does not reverse issuance order when the wall clock is adjusted backwards before a restart that restores the last issued number', () => {
    const before = createRenewalIssuer();
    const oldRenewal = before(100_000);
    const restarted = createRenewalIssuer(before.last()!);
    expect(restarted(99_000)).toBeGreaterThan(oldRenewal);
  });
  it('the unconditional form (no restored state) is NOT guaranteed and is documented as such', () => {
    const oldRenewal = createRenewalIssuer()(100_000);
    expect(createRenewalIssuer()(99_000)).toBeLessThan(oldRenewal);
  });
});
