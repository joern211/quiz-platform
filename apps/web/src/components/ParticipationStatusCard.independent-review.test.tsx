import { Profiler, StrictMode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PARTICIPATION_CONTRACT, type ParticipationExpectedContext, type ParticipationProjection } from '@quiz/shared/participation';
import { ParticipationStatusCard } from './ParticipationStatusCard';

afterEach(cleanup);
const expected: ParticipationExpectedContext = { runIndex: 2, trackId: 'review-track', rosterRevision: 'review-roster', actorKind: 'PARTICIPANT', actorId: 'p1', minStateVersion: 3 };
function own(version: number, status: 'ACTIVE' | 'ELIMINATED', value: number): ParticipationProjection {
  return { contract: PARTICIPATION_CONTRACT, scope: { runIndex: 2, trackId: 'review-track', rosterRevision: 'review-roster', actorKind: 'PARTICIPANT' }, stateVersion: version,
    own: { actorId: 'p1', status, lives: { state: 'VALUE', value } }, public: [] };
}

describe('Independent N6 review: keep version knowledge while discarding private data', () => {
  it('does not revive an actor through a temporary missing projection followed by a delayed older snapshot of the SAME context', () => {
    const commits: string[] = [];
    const tree = (projection: ParticipationProjection | null) => <StrictMode><Profiler id="review" onRender={() => { commits.push(document.body.textContent ?? ''); }}>
      <ParticipationStatusCard expected={expected} projection={projection} />
    </Profiler></StrictMode>;
    const v = render(tree(own(9, 'ELIMINATED', 0)));
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
    v.rerender(tree(null));
    expect(screen.queryByText('Ausgeschieden')).not.toBeInTheDocument();
    const mark = commits.length;
    v.rerender(tree(own(5, 'ACTIVE', 3)));
    expect(screen.queryByText('Aktiv')).not.toBeInTheDocument();
    expect(screen.queryByText('3')).not.toBeInTheDocument();
    expect(commits.slice(mark).every(text => !/Aktiv/.test(text))).toBe(true);
    v.rerender(tree(own(10, 'ELIMINATED', 0)));
    expect(screen.getByText('Ausgeschieden')).toBeInTheDocument();
  });

  it('does not restore a revoked private life value after a NEWER valid projection explicitly contains NO actor record', () => {
    const tree = (projection: ParticipationProjection) => <StrictMode><ParticipationStatusCard expected={expected} projection={projection} /></StrictMode>;
    const v = render(tree(own(8, 'ACTIVE', 777)));
    expect(screen.getByText('777')).toBeInTheDocument();
    v.rerender(tree({ ...own(10, 'ACTIVE', 555), own: null, public: [] }));
    expect(screen.queryByText('777')).not.toBeInTheDocument();
    expect(screen.getByText('Der Status ist zurzeit nicht verfügbar.')).toBeInTheDocument();
    v.rerender(tree(own(9, 'ACTIVE', 555)));
    expect(screen.queryByText('555')).not.toBeInTheDocument();
    expect(screen.queryByText('Deine eigene Angabe.')).not.toBeInTheDocument();
  });
});
