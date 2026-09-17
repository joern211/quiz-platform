// ============================================================
// Session Store – sessionStorage wrapper
// Keys: qp_rejoinToken, qp_participationId, qp_roomCode, qp_role
// ============================================================

export type PlayerRole = 'MODERATOR' | 'PLAYER' | 'VIEWER';

export interface SessionStore {
  rejoinToken: string | null;
  participationId: string | null;
  roomCode: string | null;
  role: PlayerRole | null;
}

const KEYS = {
  rejoinToken: 'qp_rejoinToken',
  participationId: 'qp_participationId',
  roomCode: 'qp_roomCode',
  role: 'qp_role',
} as const;

export function getSession(): SessionStore {
  return {
    rejoinToken: sessionStorage.getItem(KEYS.rejoinToken),
    participationId: sessionStorage.getItem(KEYS.participationId),
    roomCode: sessionStorage.getItem(KEYS.roomCode),
    role: (sessionStorage.getItem(KEYS.role) as PlayerRole | null),
  };
}

export function setSession(data: Partial<SessionStore>): void {
  if (data.rejoinToken !== undefined) {
    if (data.rejoinToken) sessionStorage.setItem(KEYS.rejoinToken, data.rejoinToken);
    else sessionStorage.removeItem(KEYS.rejoinToken);
  }
  if (data.participationId !== undefined) {
    if (data.participationId) sessionStorage.setItem(KEYS.participationId, data.participationId);
    else sessionStorage.removeItem(KEYS.participationId);
  }
  if (data.roomCode !== undefined) {
    if (data.roomCode) sessionStorage.setItem(KEYS.roomCode, data.roomCode);
    else sessionStorage.removeItem(KEYS.roomCode);
  }
  if (data.role !== undefined) {
    if (data.role) sessionStorage.setItem(KEYS.role, data.role);
    else sessionStorage.removeItem(KEYS.role);
  }
}

export function clearSession(): void {
  sessionStorage.removeItem(KEYS.rejoinToken);
  sessionStorage.removeItem(KEYS.participationId);
  sessionStorage.removeItem(KEYS.roomCode);
  sessionStorage.removeItem(KEYS.role);
}
