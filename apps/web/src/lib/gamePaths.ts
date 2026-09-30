export function gamePath(slug: string | undefined, role: 'MODERATOR' | 'PLAYER' | 'VIEWER', code: string): string {
  if (slug === 'weristdas') {
    return role === 'MODERATOR' ? `/moderator/raum/${code}/weristdas`
      : role === 'PLAYER' ? `/weristdas/spiel/${code}` : `/weristdas/zuschauer/${code}`;
  }
  if (slug === 'jeopardy') {
    return role === 'MODERATOR' ? `/moderator/raum/${code}/jeopardy`
      : role === 'PLAYER' ? `/jeopardy/spiel/${code}` : `/jeopardy/zuschauer/${code}`;
  }
  return role === 'MODERATOR' ? `/moderator/raum/${code}/spiel`
    : role === 'PLAYER' ? `/raum/${code}/spiel` : `/zuschauen/${code}/spiel`;
}
