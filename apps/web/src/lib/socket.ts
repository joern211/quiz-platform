// ============================================================
// Typed Socket.IO Client - v0.3.0
// All socket events go through here with full TypeScript typing.
// ============================================================

import { io, Socket } from 'socket.io-client';

export type PlayerRole = 'MODERATOR' | 'PLAYER' | 'VIEWER';

export interface RoomState {
  roomId: string;
  code: string;
  status: string;
  runPhase: string;
  gameSlug?: string; // sent by server to enable game-specific navigation
  players: Array<{
    id: string;
    displayName: string;
    role: PlayerRole;
    connected: boolean;
    ready: boolean;
    score: number;
  }>;
  selfParticipationId: string;
}

export interface GameStartPayload {
  roomId: string;
  gameSlug: string;
  status: string;
  runPhase: string;
  roomCode: string;
}

export interface GeoAnswerPayload {
  roomCode: string;
  optionId: string;
}

export interface GeoJokerPayload {
  roomCode: string;
}

export interface BuzzPayload {
  roomCode: string;
}

export type ServerToClientEvents = {
  'room:snapshot': (state: RoomState & { identity?: { participationId: string; role: PlayerRole } }) => void;
  'room:update': (state: RoomState) => void;
  'room:updated': (data: { roomCode: string; revision: number; players: any[]; viewerCount?: number }) => void;
  'player:join': (data: { player: { id: string; displayName: string; role: PlayerRole } }) => void;
  'player:leave': (data: { playerId: string }) => void;
  'room:player:joined': (player: { id: string; displayName: string; role: PlayerRole }) => void;
  'room:player:left': (data: { participationId: string }) => void;
  'room:player:ready': (data: { participationId: string; ready: boolean }) => void;
  'player:ready:set': (data: { playerId: string; ready: boolean }) => void;
  'room:kicked': (data: { participationId?: string; reason?: string }) => void;
  'game:start': (data: { roomCode: string; status?: string; runPhase?: string; gameSlug?: string }) => void;
  'game:started': (data: GameStartPayload) => void;
  'game:end': (data: { roomCode: string; status: string; runPhase: string; finalScores?: Array<{ participationId: string; displayName: string; score: number }> }) => void;
  'geo:question': (data: {
    roundIndex: number;
    totalQuestions: number;
    question: {
      id: string;
      prompt: string;
      category: string;
      options: Array<{ id: string; label: string; text: string; imageUrl?: string }>;
      imageUrl?: string;
    };
    timerMs: number;
    timerEndMs: number;
    buzzOpen: boolean;
  }) => void;
  'geo:reveal': (data: { correctOptionId?: string; correctOptionText?: string; explanation?: string; scores: Array<{ participationId: string; displayName: string; score: number; correct: boolean; bonus: number }> }) => void;
  'geo:timer-expired': (data: { roundIndex: number }) => void;
  'geo:buzzer': (data: { winnerId: string }) => void;
  'geo:next': (data: { nextRoundIndex?: number; roundIndex: number; totalQuestions: number }) => void;
  'geo:init': (data: { questionCount: number; phase: string }) => void;
  'geo:answered': (data: { participantId: string; questionIndex: number; optionId: string }) => void;
  'geo:joker:5050:result': (data: { roundIndex: number; options: any[]; eliminated: string[] }) => void;
  'geo:joker:spy:result': (data: { roundIndex: number; distribution: Record<string, number> }) => void;
  'geo:joker:risk:result': (data: { roundIndex: number; active: boolean }) => void;
  // ── Jeopardy ────────────────────────────────────────────────
  'jeopardy:init': (data: { boardNumber: 1 | 2; categories: Array<{ name: string; clueCount: number }>; values: number[]; scores: Record<string, number>; playerNames?: Record<string, string> }) => void;
  'jeopardy:field:open': (data: { categoryIndex: number; value: number; question: string; mediaType?: string; mediaAssetId?: string }) => void;
  'jeopardy:answer:secret': (data: { answer: string }) => void; // Moderator only
  'jeopardy:reveal': (data: { answer: string; correct: boolean; playerId: string; playerName: string; fieldValue: number; delta: number; scores: Record<string, number> }) => void;
  'jeopardy:steal:open': (data: { categoryIndex: number; value: number; scores?: Record<string, number> }) => void;
  'jeopardy:steal:close': (data: { answer: string; thiefCorrect: boolean; thiefDelta: number; scores: Record<string, number> }) => void;
  'jeopardy:field:done': (data: { categoryIndex: number; value: number }) => void;
  'jeopardy:next': () => void;
  'jeopardy:buzz:won': (data: { playerId: string; playerName: string }) => void;
  'jeopardy:steal:buzz:won': (data: { playerId: string; playerName: string }) => void;
  'jeopardy:board:switch': (data: { fromBoard: 1 | 2; toBoard: 2 | 1; categories: Array<{ name: string; clueCount: number }>; values: number[]; scores: Record<string, number> }) => void;
  'jeopardy:board:complete': (data: { boardNumber: 1 | 2; nextBoard: 2 | null }) => void;
  'jeopardy:game:end': (data: { finalScores: Array<{ playerId: string; playerName: string; score: number }>; winnerIds: string[] }) => void;
  'buzz:won': (data: { playerId: string; displayName: string }) => void;
  'buzz:press': (data: BuzzPayload) => void;
  'game:pause': (data: { roomCode: string }) => void;
  'game:resume': (data: { roomCode: string }) => void;
  'lobby:chat:message': (data: { id?: string; senderId?: string; senderName: string; content: string; createdAt?: string }) => void;
  'lobby:chat:lock': (data: { locked: boolean }) => void;
  'session:replaced': () => void;
  'error': (data: { code: string; message: string }) => void;
};

export type ClientToServerEvents = {
  'room:subscribe': (data: { roomCode: string; rejoinToken?: string; pin?: string; role?: PlayerRole }, ack: (res: { success: boolean; error?: string; snapshot?: RoomState }) => void) => void;
  'room:resync': (data: { roomCode: string; rejoinToken?: string }, ack: (res: { success: boolean; state?: RoomState }) => void) => void;
  'room:kick': (data: { roomCode: string; playerId: string }, ack: (res: { success: boolean; error?: string }) => void) => void;
  'player:ready:set': (data: { roomCode: string; ready: boolean; rejoinToken?: string }, ack: (res: { success: boolean }) => void) => void;
  'game:start': (data: { roomCode: string }, ack: (res: { success: boolean; error?: string; gameSlug?: string }) => void) => void;
  'game:pause': (data: { roomCode: string }, ack: (res: { success: boolean; error?: string }) => void) => void;
  'game:resume': (data: { roomCode: string }, ack: (res: { success: boolean; error?: string }) => void) => void;
  'game:end': (data: { roomCode: string }, ack: (res: { success: boolean; error?: string }) => void) => void;
  'geo:answer': (data: GeoAnswerPayload & { rejoinToken?: string }, ack: (res: { success: boolean; error?: string }) => void) => void;
  'geo:joker:5050': (data: GeoJokerPayload & { rejoinToken?: string }, ack: (res: { success: boolean; error?: string; eliminatedOptions?: string[] }) => void) => void;
  'geo:joker:spy': (data: GeoJokerPayload & { rejoinToken?: string }, ack: (res: { success: boolean; error?: string; distribution?: Record<string, number> }) => void) => void;
  'geo:joker:risk': (data: GeoJokerPayload & { rejoinToken?: string }, ack: (res: { success: boolean; error?: string }) => void) => void;
  'geo:reveal': (data: GeoJokerPayload, ack: (res: { success: boolean; error?: string }) => void) => void;
  'geo:next': (data: GeoJokerPayload, ack: (res: { success: boolean; error?: string; ended?: boolean }) => void) => void;
  'buzz:press': (data: BuzzPayload & { rejoinToken?: string }, ack: (res: { success: boolean }) => void) => void;
  // ── Jeopardy ────────────────────────────────────────────────
  'jeopardy:field:open': (data: { boardIndex: 1 | 2; categoryIndex: number; value: number; rejoinToken?: string }, ack: (res: { success: boolean; error?: string }) => void) => void;
  'jeopardy:buzz': (data: { rejoinToken?: string }, ack: (res: { success: boolean; error?: string }) => void) => void;
  'jeopardy:judge': (data: { correct: boolean; rejoinToken?: string }, ack: (res: { success: boolean; error?: string }) => void) => void;
  'jeopardy:steal:buzz': (data: { rejoinToken?: string }, ack: (res: { success: boolean; error?: string }) => void) => void;
  'jeopardy:steal:judge': (data: { correct: boolean; rejoinToken?: string }, ack: (res: { success: boolean; error?: string }) => void) => void;
  'jeopardy:next': (data: { rejoinToken?: string }, ack: (res: { success: boolean; error?: string }) => void) => void;
  'jeopardy:board:switch': (data: { toBoard: 2 | 1; rejoinToken?: string }, ack: (res: { success: boolean; error?: string }) => void) => void;
  'jeopardy:resync': (data: Record<string, never>, ack: (res: JeopardyResyncResponse) => void) => void;
  'lobby:chat:send': (data: { roomCode: string; content: string }, ack: (res: { success: boolean }) => void) => void;
  'lobby:chat:lock': (data: { roomCode: string; locked: boolean }, ack: (res: { success: boolean }) => void) => void;
};

export interface JeopardyResyncResponse {
  success: boolean;
  error?: string;
  currentBoard?: 1 | 2;
  phase?: 'INTRO' | 'SELECTING' | 'BUZZ_OPEN' | 'BUZZ_LOCKED' | 'STEAL_OPEN' | 'STEAL_LOCKED' | 'FIELD_DONE' | 'BOARD_COMPLETE' | 'GAME_END';
  scores?: Array<{ playerId: string; playerName: string; score: number }>;
  playerNames?: Record<string, string>;
  currentField?: { categoryIndex: number; value: number; question: string; answer?: string; buzzWinnerId?: string | null; buzzWinnerName?: string | null } | null;
  playedFields?: string[];
  board1Categories?: Array<{ name: string; clueCount: number }>;
  board2Categories?: Array<{ name: string; clueCount: number }>;
  board1Values?: number[];
  board2Values?: number[];
  buzzWinnerId?: string | null;
  stealWinnerId?: string | null;
  finalScores?: Array<{ playerId: string; playerName: string; score: number }>;
}

// ── Session storage helpers ───────────────────────────────────

const SESSION_KEYS = {
  participationId: 'qp_participationId',
  rejoinToken: 'qp_rejoinToken',
  roomCode: 'qp_roomCode',
  role: 'qp_role',
} as const;

export interface SessionData {
  participationId: string | null;
  rejoinToken: string | null;
  roomCode: string | null;
  role: PlayerRole | null;
}

export function getSessionData(): SessionData {
  return {
    participationId: sessionStorage.getItem(SESSION_KEYS.participationId),
    rejoinToken: sessionStorage.getItem(SESSION_KEYS.rejoinToken),
    roomCode: sessionStorage.getItem(SESSION_KEYS.roomCode),
    role: sessionStorage.getItem(SESSION_KEYS.role) as PlayerRole | null,
  };
}

export function setSessionData(data: {
  participationId?: string;
  rejoinToken?: string;
  roomCode?: string;
  role?: PlayerRole;
}) {
  if (data.participationId !== undefined) {
    if (data.participationId) sessionStorage.setItem(SESSION_KEYS.participationId, data.participationId);
    else sessionStorage.removeItem(SESSION_KEYS.participationId);
  }
  if (data.rejoinToken !== undefined) {
    if (data.rejoinToken) sessionStorage.setItem(SESSION_KEYS.rejoinToken, data.rejoinToken);
    else sessionStorage.removeItem(SESSION_KEYS.rejoinToken);
  }
  if (data.roomCode !== undefined) {
    if (data.roomCode) sessionStorage.setItem(SESSION_KEYS.roomCode, data.roomCode);
    else sessionStorage.removeItem(SESSION_KEYS.roomCode);
  }
  if (data.role !== undefined) {
    if (data.role) sessionStorage.setItem(SESSION_KEYS.role, data.role);
    else sessionStorage.removeItem(SESSION_KEYS.role);
  }
}

export function clearSessionData() {
  sessionStorage.removeItem(SESSION_KEYS.participationId);
  sessionStorage.removeItem(SESSION_KEYS.rejoinToken);
  sessionStorage.removeItem(SESSION_KEYS.roomCode);
  sessionStorage.removeItem(SESSION_KEYS.role);
}

export function hasActiveRoom(): boolean {
  return !!sessionStorage.getItem(SESSION_KEYS.roomCode);
}

export function getActiveRoomCode(): string | null {
  return sessionStorage.getItem(SESSION_KEYS.roomCode);
}

// ── Socket Instance ────────────────────────────────────────────

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

export function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  if (!socket) {
    socket = io('/', {
      transports: ['websocket', 'polling'],
      autoConnect: false,
    });
  }
  return socket;
}

export function connectSocket() {
  getSocket().connect();
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

// ── Kick Player Helper ─────────────────────────────────────────
// Used by ModeratorLobbyPage to emit room:kick events

export function kickPlayer(roomCode: string, playerId: string, callback?: (res: { success: boolean; error?: string }) => void) {
  getSocket().emit('room:kick', { roomCode, playerId }, callback ?? (() => {}));
}
