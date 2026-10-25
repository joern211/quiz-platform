import type { ContentItemView, ContentPoolView } from '@quiz/shared';

export class ContentApiError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1/content${path}`, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await res.json();
  if (!res.ok || !json.success) throw new ContentApiError(json.error?.code ?? 'HTTP_ERROR', json.error?.message ?? 'Inhalte konnten nicht geladen werden.', json.error?.details);
  return json.data as T;
}
export const contentApi = {
  pools: (gameSlug?: string) => request<ContentPoolView[]>(`/pools${gameSlug ? `?gameSlug=${encodeURIComponent(gameSlug)}` : ''}`),
  pool: (id: string) => request<{ pool: ContentPoolView; items: ContentItemView[] }>(`/pools/${encodeURIComponent(id)}`),
  createPool: (gameSlug: string, name: string) => request<ContentPoolView>('/pools', 'POST', { commandId: crypto.randomUUID(), gameSlug, name }),
  fork: (id: string) => request<ContentPoolView>(`/pools/${encodeURIComponent(id)}/fork`, 'POST', { commandId: crypto.randomUUID() }),
  create: (poolId: string, item: unknown) => request<ContentItemView>(`/pools/${encodeURIComponent(poolId)}/items`, 'POST', { commandId: crypto.randomUUID(), item }),
  save: (id: string, revision: number, item: unknown) => request<ContentItemView>(`/items/${encodeURIComponent(id)}`, 'PUT', { commandId: crypto.randomUUID(), revision, item }),
  status: (item: ContentItemView, status: string) => request<ContentItemView>(`/items/${encodeURIComponent(item.id)}/status`, 'POST', { commandId: crypto.randomUUID(), revision: item.revision, status }),
  history: (id: string) => request<Array<{ revision: number; kind: string; createdAt: string; changedFields: string[]; snapshot: Record<string, unknown> }>>(`/items/${encodeURIComponent(id)}/history`),
  restore: (item: ContentItemView, targetRevision: number) => request<ContentItemView>(`/items/${encodeURIComponent(item.id)}/restore`, 'POST', { commandId: crypto.randomUUID(), revision: item.revision, targetRevision }),
  preview: (id: string, role: string, reveal: boolean) => request<Record<string, unknown>>(`/items/${encodeURIComponent(id)}/preview?role=${role}&reveal=${reveal}`),
  importPreview: (poolId: string, format: string, fileBase64: string) => request<{ importId: string; rows: ImportPreviewRow[] }>(`/pools/${encodeURIComponent(poolId)}/import/preview`, 'POST', { format, fileBase64 }),
  importCommit: (input: unknown) => request<{ results: Array<{ index: number; status: string }> }>('/imports/commit', 'POST', input),
  submitPublic: (pool: ContentPoolView) => request(`/pools/${encodeURIComponent(pool.id)}/submit-public`, 'POST', { commandId: crypto.randomUUID(), revision: pool.revision }),
  propose: (item: ContentItemView, draft: unknown) => request<{ item: ContentItemView; kind: string }>(`/items/${encodeURIComponent(item.id)}/propose`, 'POST', { commandId: crypto.randomUUID(), revision: item.revision, item: draft }),
  reviews: () => request<ReviewView[]>('/reviews'),
  decide: (id: string, approve: boolean, reason: string) => request(`/reviews/${encodeURIComponent(id)}/decide`, 'POST', { commandId: crypto.randomUUID(), approve, reason }),
  inbox: () => request<Array<{ id: string; message: string; readAt: string | null; createdAt: string }>>('/inbox'),
  markRead: (id: string) => request(`/inbox/${encodeURIComponent(id)}/read`, 'POST', { commandId: crypto.randomUUID() }),
  quality: (id: string) => request<{ health: string; counts: Record<string, number>; warnings: Array<{ kind: string }>; duplicateCount: number }>(`/pools/${encodeURIComponent(id)}/quality`),
  tags: () => request<Array<{ id: string; name: string; slug: string }>>('/tags'),
  createTag: (name: string, slug: string) => request<{ id: string; name: string; slug: string }>('/tags', 'POST', { commandId: crypto.randomUUID(), name, slug }),
  findEditors: (q: string) => request<Array<{ id: string; displayName: string }>>(`/editors/search?q=${encodeURIComponent(q)}`),
  poolEditors: (id: string) => request<Array<{ id: string; displayName: string }>>(`/pools/${encodeURIComponent(id)}/editors`),
  updatePool: (pool: ContentPoolView, values: unknown) => request<ContentPoolView>(`/pools/${encodeURIComponent(pool.id)}`, 'PUT', { commandId: crypto.randomUUID(), revision: pool.revision, ...(values as object) }),
};
export interface ImportPreviewRow { index: number; classification: string; targetId: string | null; targetRevision: number | null; title: string; errors: string[]; unknownTags: string[]; proposed: unknown; current: unknown }
export interface ReviewView { id: string; kind: string; poolName: string; canDecide: boolean; proposed: unknown; createdAt: string }
