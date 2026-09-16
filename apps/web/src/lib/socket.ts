// ============================================================
// Typed Socket.IO Client - v0.2.1
// All socket events go through here with full TypeScript typing.
// ============================================================

import { io, Socket } from 'socket.io-client';

export type PlayerRole = 'MODERATOR' | 'PLAYER' | 'VIEWER';

export interface RoomState {
  roomId: string;
  code: string;
  status: string;
  runPhase: string;
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
  'room:update': (state: RoomState) => void;
  'room:player:joined': (player: { id: string; displayName: string; role: PlayerRole }) => void;
  'room:player:left': (data: { participationId: string }) => void;
  'room:player:ready': (data: { participationId: string; ready: boolean }) => void;
  'game:started': (data: GameStartPayload) => void;
  'game:ended': (data: { roomId: string; finalScores: Record<string, number> }) => void;
  'geo:question': (data: {
    roundIndex: number;
    totalRounds: number;
    question: {
      id: string;
      text: string;
      options: Array<{ id: string; label: string; text: string }>;
      mediaUrl?: string;
    };
    timerEndMs: number;
    buzzOpen: boolean;
  }) => void;
  'geo:reveal': (data: { correctOptionId: string; scores: Record<string, number> }) => void;
  'geo:buzzer': (data: { winnerId: string }) => void;
  'geo:next': (data: { roundIndex: number }) => void;
  'lobby:chat': (data: { senderName: string; text: string; timestamp: string }) => void;
  'error': (data: { code: string; message: string }) => void;
};

export type ClientToServerEvents = {
  'room:subscribe': (data: { roomCode: string; rejoinToken?: string; role?: PlayerRole }, ack: (res: { success: boolean; error?: string; state?: RoomState }) => void) => void;
  'room:resync': (data: { roomCode: string }, ack: (res: { success: boolean; state?: RoomState }) => void) => void;
  'player:ready:set': (data: { roomCode: string; ready: boolean }, ack: (res: { success: boolean }) => void) => void;
  'game:start': (data: { roomCode: string }, ack: (res: { success: boolean; error?: string }) => void) => void;
  'game:pause': (data: { roomCode: string }, ack: (res: { success: boolean }) => void) => void;
  'game:resume': (data: { roomCode: string }, ack: (res: { success: boolean }) => void) => void;
  'game:end': (data: { roomCode: string }, ack: (res: { success: boolean }) => void) => void;
  'geo:answer': (data: GeoAnswerPayload, ack: (res: { success: boolean }) => void) => void;
  'geo:joker:5050': (data: GeoJokerPayload, ack: (res: { success: boolean; eliminatedOptions?: string[] }) => void) => void;
  'geo:joker:spy': (data: GeoJokerPayload, ack: (res: { success: boolean; distribution?: Record<string, number> }) => void) => void;
  'geo:joker:risk': (data: GeoJokerPayload, ack: (res: { success: boolean }) => void) => void;
  'geo:reveal': (data: GeoJokerPayload, ack: (res: { success: boolean }) => void) => void;
  'geo:next': (data: GeoJokerPayload, ack: (res: { success: boolean }) => void) => void;
  'buzz:press': (data: BuzzPayload, ack: (res: { success: boolean }) => void) => void;
  'lobby:chat:send': (data: { roomCode: string; text: string }, ack: (res: { success: boolean }) => void) => void;
};

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
