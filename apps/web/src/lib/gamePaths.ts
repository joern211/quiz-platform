import { resolveCanonicalSlug, GAME_SLUGS } from '@quiz/shared';

/**
 * Spielpfad pro Rolle. Leitet sich aus dem kanonischen Slug ab.
 * Legacy-Slugs werden auf kanonisch aufgelöst (z.B. weristdas → wer-ist-das),
 * damit auch alte Links/Räume den korrekten Pfad erhalten.
 */
export function gamePath(slug: string | undefined, role: 'MODERATOR' | 'PLAYER' | 'VIEWER', code: string): string {
  const canonical = resolveCanonicalSlug(slug) ?? slug;

  if (canonical === GAME_SLUGS.werIstDas) {
    return role === 'MODERATOR' ? `/moderator/raum/${code}/wer-ist-das`
      : role === 'PLAYER' ? `/wer-ist-das/spiel/${code}` : `/wer-ist-das/zuschauer/${code}`;
  }
  if (canonical === GAME_SLUGS.jeopardy) {
    return role === 'MODERATOR' ? `/moderator/raum/${code}/jeopardy`
      : role === 'PLAYER' ? `/jeopardy/spiel/${code}` : `/jeopardy/zuschauer/${code}`;
  }
  return role === 'MODERATOR' ? `/moderator/raum/${code}/spiel`
    : role === 'PLAYER' ? `/raum/${code}/spiel` : `/zuschauen/${code}/spiel`;
}
