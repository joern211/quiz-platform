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
};
