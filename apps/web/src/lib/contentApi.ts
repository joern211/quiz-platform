import type { ContentItemView, ContentPoolView, ContentBatchSchema, ContentTemplateView, ContentPlaytestView } from '@quiz/shared';

import type { z } from 'zod';

export class ContentApiError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
const pendingIntents = new Map<string, string>();
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let intentKey: string | undefined, payload = body;
  if (body && typeof body === 'object' && 'commandId' in body && typeof body.commandId === 'string') {
    const values = { ...body } as Record<string, unknown>; delete values.commandId;
    intentKey = `${method}:${path}:${JSON.stringify(values)}`;
    const commandId = pendingIntents.get(intentKey) ?? body.commandId;
    pendingIntents.set(intentKey, commandId); payload = { ...values, commandId };
  }
  const res = await fetch(`/api/v1/content${path}`, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const json = await res.json();
  if (!res.ok || !json.success) throw new ContentApiError(json.error?.code ?? 'HTTP_ERROR', json.error?.message ?? 'Inhalte konnten nicht geladen werden.', json.error?.details);
  if (intentKey) pendingIntents.delete(intentKey);
  return json.data as T;
}
export const contentApi = {
  startPlaytest: (poolId: string, items: Array<{ id: string; revision: number }>) => request<{ code: string; expiresAt: string }>('/playtests', 'POST', { commandId: crypto.randomUUID(), poolId, items }),
  playtest: (code: string, role: string, clientKey: string) => request<ContentPlaytestView>(`/playtests/${encodeURIComponent(code)}?role=${role}&clientKey=${clientKey}`),
  controlPlaytest: (code: string, version: number, action: 'REVEAL' | 'NEXT' | 'CLOSE') => request(`/playtests/${encodeURIComponent(code)}/control`, 'POST', { commandId: crypto.randomUUID(), version, action }),
  playtestFeedback: (code: string, input: { clientKey: string; version: number; role: string; kind: 'ANSWER' | 'REPORT'; value: string }) => request(`/playtests/${encodeURIComponent(code)}/feedback`, 'POST', input),
  templates: (gameSlug: string) => request<ContentTemplateView[]>(`/templates/catalog?gameSlug=${encodeURIComponent(gameSlug)}`),
  saveTemplate: (gameSlug: string, name: string, item: unknown) => request('/templates', 'POST', { commandId: crypto.randomUUID(), gameSlug, name, item }),
  useTemplate: (template: ContentTemplateView, pool: ContentPoolView) => request<ContentItemView>(`/templates/${encodeURIComponent(template.id)}/use`, 'POST', { commandId: crypto.randomUUID(), revision: template.revision, poolId: pool.id, poolRevision: pool.revision }),
  archiveTemplate: (template: ContentTemplateView) => request(`/templates/${encodeURIComponent(template.id)}/archive`, 'POST', { commandId: crypto.randomUUID(), revision: template.revision }),
  assignments: (itemId?: string) => request<ContentAssignmentView[]>(`/assignments${itemId ? `?itemId=${encodeURIComponent(itemId)}` : ''}`),
  assignReview: (item: ContentItemView, assigneeId: string, note: string, assignmentRevision: number | null) => request('/assignments', 'POST', { commandId: crypto.randomUUID(), itemId: item.id, itemRevision: item.revision, assigneeId, note, assignmentRevision }),
  advanceAssignment: (task: ContentAssignmentView, status: string) => request(`/assignments/${encodeURIComponent(task.id)}/status`, 'POST', { commandId: crypto.randomUUID(), revision: task.revision, status }),
  media: (id: string) => request<{ url: string; type: string }>(`/items/${encodeURIComponent(id)}/media`),
  batchPreview: (batch: z.infer<typeof ContentBatchSchema>) => request<BatchPreview>('/batch/preview', 'POST', batch),
  batchCommit: (batch: z.infer<typeof ContentBatchSchema>) => request<{ results: Array<{ id: string; status: string; error?: string }> }>('/batch/commit', 'POST', { commandId: crypto.randomUUID(), batch, confirmed: true }),
  presence: (id: string, editorKey: string, active: boolean) => request<Array<{ id: string; displayName: string }>>(`/items/${encodeURIComponent(id)}/presence`, 'POST', { editorKey, active }),
  comments: (id: string) => request<CommentView[]>(`/items/${encodeURIComponent(id)}/comments`),
  comment: (id: string, message: string) => request(`/items/${encodeURIComponent(id)}/comments`, 'POST', { commandId: crypto.randomUUID(), message }),
  resolveComment: (id: string, status: string) => request(`/comments/${encodeURIComponent(id)}/resolve`, 'POST', { commandId: crypto.randomUUID(), status }),
  lock: (item: ContentItemView, locked: boolean) => request<ContentItemView>(`/items/${encodeURIComponent(item.id)}/lock`, 'POST', { commandId: crypto.randomUUID(), revision: item.revision, locked }),
  usage: (id: string) => request<{ total: number; uses: Array<{ runIndex: number; itemRevision: number; createdAt: string; room: { id: string; roomName: string; status: string } | null }> }>(`/items/${encodeURIComponent(id)}/usage`),
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
  correctionContent: (input: { roomCode: string; participantId: string; rejoinToken: string; runIndex: number }) =>
    request<Array<{ itemId: string; revision: number; runIndex: number; payload: Record<string, unknown> }>>('/corrections/eligible', 'POST', input),
  submitCorrection: (input: unknown) => request<{ reviewId: string }>('/corrections', 'POST', input),
};
export interface ImportPreviewRow { index: number; classification: string; targetId: string | null; targetRevision: number | null; title: string; errors: string[]; unknownTags: string[]; proposed: unknown; current: unknown }
export interface ReviewView { id: string; kind: string; poolName: string; canDecide: boolean; proposed: unknown; current?: ContentItemView[]; createdAt: string }

export interface BatchPreview { total: number; eligible: number; historicallyUsed: number; rows: Array<{ id: string; title: string; revision: number; uses: number; effect: string | null; error: string | null }> }
export interface CommentView { id: string; actorId: string; message: string; status: string; createdAt: string }

export interface ContentAssignmentView { id: string; itemId: string; poolId: string; assigneeId: string; assignedBy: string; itemRevision: number; currentRevision: number; revision: number; status: string; note: string; itemTitle: string; poolName: string; stale: boolean; canAdvance: boolean }
