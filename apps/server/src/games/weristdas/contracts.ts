import { z } from 'zod';

export const WerIstDasPhase = {
  ROUND_READY: 'ROUND_READY',
  BUZZ_OPEN: 'BUZZ_OPEN',
  ANSWERING: 'ANSWERING',
  REVEAL: 'REVEAL',
  GAME_END: 'GAME_END',
} as const;

export type WerIstDasPhase = (typeof WerIstDasPhase)[keyof typeof WerIstDasPhase];

export const WerIstDasRoundSchema = z.object({
  id: z.string().min(1).max(100),
  imageAssetId: z.string().uuid(),
  person1: z.string().trim().min(1).max(150),
  person2: z.string().trim().min(1).max(150),
  aliases1: z.array(z.string().trim().min(1).max(150)).max(20).optional(),
  aliases2: z.array(z.string().trim().min(1).max(150)).max(20).optional(),
  description: z.string().max(1000).optional(),
});

export const WerIstDasSetupSchema = z.object({
  rounds: z.array(WerIstDasRoundSchema).min(1).max(50),
});

export const WerIstDasJudgeSchema = z.object({
  result: z.enum(['BOTH_CORRECT', 'ONE_CORRECT', 'WRONG']),
});

export type WerIstDasRound = z.infer<typeof WerIstDasRoundSchema>;
export type WerIstDasSetup = z.infer<typeof WerIstDasSetupSchema>;

export const WER_IST_DAS_EVENTS = {
  OPEN: 'weristdas:buzzer:open',
  BUZZ: 'weristdas:buzz',
  JUDGE: 'weristdas:judge',
  HINT: 'weristdas:hint',
  REVEAL: 'weristdas:reveal',
  NEXT: 'weristdas:next',
  RESYNC: 'weristdas:resync',
  UPDATE: 'weristdas:update',
} as const;
