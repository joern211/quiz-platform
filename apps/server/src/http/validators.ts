// ============================================================
// Online Quiz Plattform - Zod Input Validierung
// ============================================================

import { z } from 'zod';

// ---- Room Schemas ------------------------------------------------

/**
 * Validate room creation input.
 * - roomName: string 1–100 characters
 * - pin: optional, 4–10 digits
 */
export const CreateRoomSchema = z.object({
  roomName: z
    .string({ required_error: 'Raumname erforderlich.' })
    .min(1, 'Raumname darf nicht leer sein.')
    .max(100, 'Raumname max. 100 Zeichen.'),
  pin: z
    .string()
    .optional()
    .refine(
      (val) => val === undefined || /^\d{4,10}$/.test(val),
      'PIN muss 4–10 Ziffern enthalten.',
    ),
  gameSlug: z.string({ required_error: 'Spiel-Slug erforderlich.' }).min(1),
  gameDefinitionId: z.string().optional(),
  maxPlayers: z.number().int().min(2).max(100).default(10),
  cameraEnabled: z.boolean().default(false),
  allowViewers: z.boolean().default(true),
  viewerRequiresPin: z.boolean().default(true),
  viewerLimit: z.number().int().min(0).max(500).default(50),
  lobbyChatEnabled: z.boolean().default(true),
  setupSnapshotJson: z.union([z.record(z.unknown()), z.string()]).transform((v) => {
    // Accept both object and JSON-string; normalize to object for storage
    if (typeof v === 'string') {
      try { return JSON.parse(v); }
      catch { return {}; }
    }
    return v;
  }).default({}),
});

/**
 * Validate player join request.
 * - displayName: string 1–100 characters
 * - pin: optional, 4–10 digits
 */
export const JoinRoomSchema = z.object({
  displayName: z
    .string({ required_error: 'Name erforderlich.' })
    .min(1, 'Name darf nicht leer sein.')
    .max(100, 'Name max. 100 Zeichen.'),
  pin: z
    .string()
    .optional()
    .refine(
      (val) => val === undefined || /^\d{4,10}$/.test(val),
      'PIN muss 4–10 Ziffern enthalten.',
    ),
});

// ---- Auth Schemas ------------------------------------------------

/**
 * Validate login credentials.
 */
export const LoginSchema = z.object({
  username: z
    .string({ required_error: 'Benutzername erforderlich.' })
    .min(1, 'Benutzername darf nicht leer sein.'),
  password: z
    .string({ required_error: 'Passwort erforderlich.' })
    .min(1, 'Passwort darf nicht leer sein.'),
});

/**
 * Validate E2E test token request (dev-only, no password needed).
 */
export const E2ETokenSchema = z.object({
  userId: z.string().min(1, 'userId erforderlich.'),
});

// ---- Setup Schemas -----------------------------------------------

/**
 * Validate game setup input (sent by moderator before game start).
 */
export const SetupInputSchema = z.object({
  gameSlug: z.string({ required_error: 'Spiel-Slug erforderlich.' }).min(1),
  name: z
    .string({ required_error: 'Setup-Name erforderlich.' })
    .min(1)
    .max(200),
  config: z.record(z.unknown()).default({}),
});

// ---- Generic Validation Helper -----------------------------------

/**
 * Parse and validate request body against a Zod schema.
 * Returns the parsed data on success, or a 400 response on failure.
 */
export function validateBody<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
  res: { status: (code: number) => { json: (data: unknown) => void } },
): z.infer<T> | undefined {
  const result = schema.safeParse(body);
  if (!result.success) {
    const messages = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION',
        message: messages.join(' | '),
        details: result.error.errors,
      },
    });
    return undefined;
  }
  return result.data;
}
