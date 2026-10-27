/** Room capabilities belong to an engine, rather than client-supplied settings. */
const rules = {
  minTeams: 2, maxTeams: 10, minTeamSize: 1, maxTeamSize: 10,
  equality: 'ANY' as const, allowEmergencyTeamChanges: true, allowLateJoin: true,
  scoringModes: ['INDIVIDUAL_SCORE', 'TEAM_SCORE'] as const,
  emergencyActions: ['ABORT_GAME'] as const,
};
export function roomEngineRules(slug: string) {
  return ['wissensduell', 'geo', 'jeopardy', 'wer-ist-das', 'weristdas'].includes(slug) ? rules : null;
}
