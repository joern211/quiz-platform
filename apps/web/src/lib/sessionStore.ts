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

// Legacy localStorage keys for migration from old app
const LEGACY_KEYS = {
  rejoinToken: 'rejoinToken',
  participationId: 'participationId',
  roomCode: 'roomCode',
  displayName: 'displayName',
} as const;

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

/**
 * Migrate from legacy localStorage keys to new sessionStorage keys
 * Call this on app initialization to preserve existing sessions
 */
export function migrateLegacy(): SessionStore | null {
  // Check if legacy data exists in localStorage
  const legacyToken = localStorage.getItem(LEGACY_KEYS.rejoinToken);
  const legacyPartId = localStorage.getItem(LEGACY_KEYS.participationId);
  const legacyRoomCode = localStorage.getItem(LEGACY_KEYS.roomCode);
  
  if (!legacyToken && !legacyPartId) {
    // No legacy data to migrate
    return null;
  }
  
  // Get existing sessionStorage values (if any)
  const existing = getSession();
  
  // Use legacy localStorage values if sessionStorage doesn't have them
  const migrated: SessionStore = {
    rejoinToken: existing.rejoinToken || legacyToken,
    participationId: existing.participationId || legacyPartId,
    roomCode: existing.roomCode || legacyRoomCode,
    role: existing.role,
  };
  
  // Set the migrated session
  setSession(migrated);
  
  // Clear legacy localStorage after migration
  localStorage.removeItem(LEGACY_KEYS.rejoinToken);
  localStorage.removeItem(LEGACY_KEYS.participationId);
  localStorage.removeItem(LEGACY_KEYS.roomCode);
  localStorage.removeItem(LEGACY_KEYS.displayName);
  
  return migrated;
}

export function clearSession(): void {
  sessionStorage.removeItem(KEYS.rejoinToken);
  sessionStorage.removeItem(KEYS.participationId);
  sessionStorage.removeItem(KEYS.roomCode);
  sessionStorage.removeItem(KEYS.role);
}

/**
 * Check if there's an active session
 */
export function hasSession(): boolean {
  const session = getSession();
  return !!(session.rejoinToken || session.participationId);
}

/**
 * Get just the participation ID (most common use case)
 */
export function getParticipationId(): string | null {
  return sessionStorage.getItem(KEYS.participationId);
}

/**
 * Get just the rejoin token
 */
export function getRejoinToken(): string | null {
  return sessionStorage.getItem(KEYS.rejoinToken);
}
