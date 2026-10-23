import { z } from 'zod';

export const AccessModeSchema = z.enum(['PUBLIC_JOIN', 'PIN_PROTECTED', 'APPROVAL_REQUIRED', 'INVITE_ONLY']);
export const RoomPolicySchema = z.object({
  playerAccess: AccessModeSchema.default('PUBLIC_JOIN'),
  viewerAccess: AccessModeSchema.default('PUBLIC_JOIN'),
  readyRule: z.enum(['ALL_READY_REQUIRED', 'HOST_CAN_OVERRIDE', 'READY_CHECK_DISABLED']).default('ALL_READY_REQUIRED'),
  allowLateJoin: z.boolean().default(false),
  waitlist: z.boolean().default(false),
  coHostEnabled: z.boolean().default(false),
  hostGraceMs: z.number().int().min(1000).max(86400000).default(60000),
  teamMode: z.enum(['OFF', 'MANUAL', 'RANDOM', 'SELF_SELECT', 'ROTATION']).default('OFF'),
  teamCount: z.number().int().min(2).max(100).default(2),
  minTeamSize: z.number().int().min(1).max(100).default(1),
  maxTeamSize: z.number().int().min(1).max(100).default(100),
  equality: z.enum(['REQUIRED', 'WARN', 'ANY']).default('ANY'),
  scoring: z.enum(['INDIVIDUAL_SCORE', 'TEAM_SCORE']).default('INDIVIDUAL_SCORE'),
  allowTeamReshuffleBetweenRounds: z.boolean().default(false),
}).strict().refine(p => p.minTeamSize <= p.maxTeamSize, { message: 'TEAM_SIZE_INVALID' });
export type RoomPolicy = z.infer<typeof RoomPolicySchema>;
export const ParticipantNameSchema = z.string().transform(s => s.normalize('NFKC').trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(100).refine(s => !/[\p{Cc}\p{Cf}]/u.test(s), 'NAME_INVALID'));
export function normalizedParticipantName(name: string): string {
  return ParticipantNameSchema.parse(name).toLocaleLowerCase('de-DE');
}
export const RoomOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('POLICY'), policy: RoomPolicySchema }),
  z.object({ type: z.literal('LOCK'), locked: z.boolean() }),
  z.object({ type: z.literal('SCHEDULE'), scheduledAt: z.string().datetime(), expiresAt: z.string().datetime().optional() }),
  z.object({ type: z.literal('OPEN') }),
  z.object({ type: z.literal('TEAMS_ASSIGN'), mode: z.enum(['MANUAL', 'RANDOM', 'ROTATION']), assignments: z.record(z.string().nullable()).optional(), override: z.boolean().default(false) }),
  z.object({ type: z.literal('TEAM_EDIT'), teamId: z.string(), name: z.string().trim().min(1).max(50), color: z.string().regex(/^#[a-fA-F0-9]{6}$/), icon: z.string().min(1).max(16) }),
  z.object({ type: z.literal('TEAM_SELECT'), teamId: z.string() }),
  z.object({ type: z.literal('ADMIT'), participantId: z.string(), approve: z.boolean(), teamId: z.string().optional() }),
  z.object({ type: z.literal('RENAME'), participantId: z.string(), name: ParticipantNameSchema }),
  z.object({ type: z.literal('LEAVE') }),
  z.object({ type: z.literal('KICK'), participantId: z.string(), reason: z.string().max(300).optional() }),
  z.object({ type: z.literal('BAN'), participantId: z.string(), reason: z.string().max(300).optional() }),
  z.object({ type: z.literal('UNBAN'), participantId: z.string() }),
  z.object({ type: z.literal('TOKEN_ROTATE'), participantId: z.string() }),
  z.object({ type: z.literal('COHOST'), userId: z.string(), permissions: z.array(z.enum(['GAME_START', 'GAME_PAUSE', 'ROUND_ADVANCE', 'JUDGE_ANSWER', 'SCORE_ADJUST', 'BUZZER_CONTROL', 'TIMER_CONTROL', 'REVEAL_CONTENT', 'TEAM_MANAGE', 'PLAYER_MANAGE', 'GAME_ABORT'])).max(11) }),
  z.object({ type: z.literal('TRANSFER'), userId: z.string(), claim: z.boolean().default(false) }),
  z.object({ type: z.literal('INVITE'), role: z.enum(['PLAYER', 'VIEWER']) }),
  z.object({ type: z.literal('MESSAGE'), message: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal('LOBBY') }),
  z.object({ type: z.literal('REMATCH') }),
  z.object({ type: z.literal('SWITCH_GAME'), gameSlug: z.string(), setup: z.record(z.unknown()) }),
  z.object({ type: z.literal('CLOSE') }),
  z.object({ type: z.literal('EMERGENCY'), action: z.enum(['ABORT_ROUND', 'RESTART_ROUND', 'SKIP_ROUND', 'ABORT_GAME']), points: z.enum(['KEEP_POINTS', 'ROLLBACK_ROUND_POINTS']) }),
]);
export type RoomOperation = z.infer<typeof RoomOperationSchema>;
export const RoomCommandSchema = z.object({
  roomCode: z.string().regex(/^\d{3}-\d{3}$/),
  commandId: z.string().min(1).max(128),
  protocolVersion: z.literal(1),
  stateVersion: z.number().int().nonnegative().optional(),
  operation: RoomOperationSchema,
}).strict();
export type RoomCommand = z.infer<typeof RoomCommandSchema>;

export interface RoomCoreView {
  revision: number;
  lifecycle: string;
  policy: RoomPolicy;
  scheduledAt: string | null;
  hostStatus: 'ONLINE' | 'DISCONNECTED' | 'HOST_MISSING';
  canManage: boolean;
  isOwner: boolean;
  selfId: string | null;
  selfAdmission: string | null;
  teams: Array<{ id: string; name: string; color: string; icon: string; score: number }>;
  participants: Array<{ id: string; displayName: string; role: string; admission: string; connected: boolean; ready: boolean; teamId: string | null; score: number; banned: boolean; userId?: string | null }>;
  feed: Array<{ id: string; kind: string; message: string; createdAt: string }>;
  preflight: { status: 'READY_TO_START' | 'WARNINGS' | 'BLOCKED'; blockers: string[]; warnings: string[] };
  runIndex: number;
}
