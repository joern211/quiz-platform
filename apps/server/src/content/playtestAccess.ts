import { canContributePool, type ContentDb } from './core.js';

/** A shared test capability ends if its creator loses the right to share this pool. */
export async function hasPlaytestAuthority(db: ContentDb, row: { ownerId: string; poolId: string }) {
  const [owner, pool] = await Promise.all([db.user.findUnique({ where: { id: row.ownerId } }), db.contentPool.findUnique({ where: { id: row.poolId } })]);
  return !!owner && owner.disabledAt === null && ['HOST', 'ADMIN'].includes(owner.role) && !!pool && ['ACTIVE', 'LOCKED_REVIEW'].includes(pool.status)
    && canContributePool(pool, { userId: owner.id, role: owner.role, sessionId: '' });
}
