import { z } from 'zod';
export const WissensduellContentSchema = z.object({ id: z.string(), prompt: z.string().min(1), category: z.string(),
  options: z.array(z.object({ id: z.string().min(1), text: z.string() }).passthrough()).min(2), correctOptionId: z.string().min(1),
  points: z.number().int(), wrongPoints: z.number().int(), durationMs: z.number().int().positive(),
}).passthrough().refine(q => new Set(q.options.map(o => o.id)).size === q.options.length && q.options.some(o => o.id === q.correctOptionId), 'INVALID_OPTIONS');
export const WissensduellSetupSchema = z.object({ selectedQuestionIds: z.array(z.string().min(1)).optional(), questionPoolId: z.string().min(1).optional(),
  questionCount: z.number().int().positive().optional(), timerDuration: z.number().positive().optional(),
}).passthrough().refine(s => !s.selectedQuestionIds || new Set(s.selectedQuestionIds).size === s.selectedQuestionIds.length, 'DUPLICATE_CONTENT');
export const JeopardyContentSchema = z.object({ value: z.number().int().positive(), question: z.string().min(1), answer: z.string().min(1),
  mediaType: z.string().optional(), mediaAssetId: z.string().optional() }).passthrough();
const board = z.object({ categories: z.array(z.object({ name: z.string(), clues: z.array(JeopardyContentSchema).min(1)
  .refine(clues => new Set(clues.map(clue => clue.value)).size === clues.length, 'DUPLICATE_FIELD') }).passthrough()).min(1).max(6) }).passthrough();
export const JeopardySetupSchema = z.object({ board1: board, board2: board.optional() }).passthrough();
