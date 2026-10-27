import { ContentDifficultyPlanSchema, SYSTEM_DIFFICULTY_PRESETS, type ContentDifficultyPresetView } from '@quiz/shared';
import { type ContentDb, type ContentActor } from './core.js';

export async function difficultyPresetCatalog(db: ContentDb, actor: ContentActor, gameSlug: string): Promise<ContentDifficultyPresetView[]> {
  const rows = await db.contentDifficultyPreset.findMany({ where: { ownerId: actor.userId, gameSlug, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  return [...SYSTEM_DIFFICULTY_PRESETS.filter(p => gameSlug === 'wissensduell' || p.plan.kind === 'DISTRIBUTION').map(p => ({ ...p, revision: 1, gameSlug, scope: 'SYSTEM' as const })),
    ...rows.map(row => ({ id: row.id, gameSlug, name: row.name, revision: row.revision, plan: ContentDifficultyPlanSchema.parse(JSON.parse(row.planJson)), scope: 'PRIVATE' as const }))];
}
