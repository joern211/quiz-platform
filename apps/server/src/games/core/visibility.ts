/** Information roles are resolved on the server, independently of permissions. */
export interface ProjectionAudience {
  role: 'HOST' | 'PLAYER' | 'VIEWER' | 'DISPLAY';
  blindHost?: boolean;
  participantId?: string | null;
  teamId?: string | null;
}
export interface VisibilityRule {
  scope: 'HOST_PRIVATE' | 'PLAYER_PRIVATE' | 'TEAM_PRIVATE' | 'PUBLIC';
  ownerParticipantId?: string;
  ownerTeamId?: string;
  publiclyRevealed?: boolean;
}
export function canView(audience: ProjectionAudience, rule: VisibilityRule): boolean {
  if (rule.scope === 'PUBLIC' || rule.publiclyRevealed) return true;
  if (rule.scope === 'HOST_PRIVATE') return audience.role === 'HOST' && !audience.blindHost;
  if (audience.role !== 'PLAYER') return false;
  if (rule.scope === 'PLAYER_PRIVATE') return !!rule.ownerParticipantId && rule.ownerParticipantId === audience.participantId;
  return !!rule.ownerTeamId && rule.ownerTeamId === audience.teamId;
}
/** Laziness also prevents generating a secret signed URL for the wrong audience. */
export function visibleValue<T>(audience: ProjectionAudience, rule: VisibilityRule, read: () => T): T | undefined {
  return canView(audience, rule) ? read() : undefined;
}
