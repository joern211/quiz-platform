// ============================================================
// Typed API Client - v0.2.1
// All HTTP calls go through here. Central ApiResponse<T> handling.
// ============================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

// Helper: unwrap API response
function unwrap<T>(res: ApiResponse<T>): T {
  if (!res.success || res.data === undefined) {
    throw new Error(res.error?.message ?? 'API error');
  }
  return res.data;
}

const BASE = '/api/v1';

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const res = await fetch(BASE + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  return res.json();
}

// ── Auth ──────────────────────────────────────────────────────

export const authApi = {
  login: (username: string, password: string) =>
    apiFetch<{ sessionId: string; user: { id: string; displayName: string; role: string } }>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ username, password }) }
    ),

  logout: () =>
    apiFetch<void>('/auth/logout', { method: 'POST' }),

  me: () =>
    apiFetch<{ id: string; displayName: string; role: string }>('/auth/me'),
};

// ── Catalog ───────────────────────────────────────────────────

export const catalogApi = {
  categories: () =>
    apiFetch<Array<{ id: string; slug: string; name: string; description: string; gameCount: number }>>(
      '/catalog/categories'
    ),

  games: (category?: string) =>
    apiFetch<Array<{ id: string; slug: string; name: string; status: string; rules: string[] }>>(
      '/catalog/games' + (category ? `?category=${category}` : '')
    ),
};

// ── Rooms ─────────────────────────────────────────────────────

export interface RoomSummary {
  id: string;
  code: string;
  roomName: string;
  status: string;
  maxPlayers: number;
  allowViewers: boolean;
  playerCount: number;
  viewerCount: number;
  game: { slug: string; name: string } | null;
  createdAt: string;
}

export interface CreateRoomRequest {
  gameSlug?: string;
  gameDefinitionId?: string;
  roomName: string;
  isPublic?: boolean;
  pin?: string;
  maxPlayers?: number;
  cameraEnabled?: boolean;
  allowViewers?: boolean;
  lobbyChatEnabled?: boolean;
  setupSnapshotJson?: Record<string, unknown>;
}

export interface CreateRoomResponse {
  id: string;
  code: string;
  roomName: string;
  status: string;
}

export const roomsApi = {
  listPublic: () =>
    apiFetch<RoomSummary[]>('/rooms/public'),

  create: (body: CreateRoomRequest) =>
    apiFetch<CreateRoomResponse>('/rooms', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  get: (code: string) =>
    apiFetch<CreateRoomResponse>(`/rooms/${code}`),

  join: (code: string, displayName: string, pin?: string) =>
    apiFetch<{ participationId: string; rejoinToken: string; roomId: string; displayName: string }>(
      `/rooms/${code}/join`,
      { method: 'POST', body: JSON.stringify({ displayName, pin }) }
    ),

  close: (code: string) =>
    apiFetch<void>(`/rooms/${code}`, { method: 'DELETE' }),
};

// Export helpers for use in pages
export { unwrap };
// ApiResponse is exported at the top
