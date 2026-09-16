// ============================================================
// Online Quiz Plattform - Server Config
// ============================================================

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(5173),
  DATABASE_URL: z.string().default('file:./storage/database/quiz.db'),
  SESSION_SECRET: z.string().min(32),
  INITIAL_ADMIN_USERNAME: z.string().default('admin'),
  INITIAL_ADMIN_PASSWORD: z.string().default('admin123'),
  PUBLIC_APP_URL: z.string().default('http://localhost:5173'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  STORAGE_ROOT: z.string().default('./storage'),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().default(50),
  MAX_IMAGE_SIZE_MB: z.coerce.number().int().default(10),
  MAX_AVATAR_SIZE_MB: z.coerce.number().int().default(5),
  ROOM_ARCHIVE_HOURS: z.coerce.number().int().default(24),
  CODE_REUSE_DAYS: z.coerce.number().int().default(30),
  DEFAULT_VIEWER_LIMIT: z.coerce.number().int().default(50),
  GEO_DEFAULT_TIMER_MS: z.coerce.number().int().default(20000),
  GEO_MIN_TIMER_MS: z.coerce.number().int().default(5000),
  GEO_DEFAULT_POINTS: z.coerce.number().int().default(100),
  GEO_DEFAULT_WRONG_POINTS: z.coerce.number().int().default(0),
  JEOPARDY_DEFAULT_TIMER_MS: z.coerce.number().int().default(20000),
  JEOPARDY_BUZZER_LOCKOUT_MS: z.coerce.number().int().default(1000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().default(7),
  BACKUP_PATH: z.string().default('./storage/backups'),
});

function loadConfig() {
  const raw = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT || '5173',
    DATABASE_URL: process.env.DATABASE_URL || 'file:./storage/database/quiz.db',
    SESSION_SECRET: process.env.SESSION_SECRET || 'CHANGE_ME_TO_A_RANDOM_SECRET_AT_LEAST_32_CHARS',
    INITIAL_ADMIN_USERNAME: process.env.INITIAL_ADMIN_USERNAME || 'admin',
    INITIAL_ADMIN_PASSWORD: process.env.INITIAL_ADMIN_PASSWORD || 'admin123',
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL || 'http://localhost:5173',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:5173',
    STORAGE_ROOT: process.env.STORAGE_ROOT || './storage',
    MAX_UPLOAD_SIZE_MB: process.env.MAX_UPLOAD_SIZE_MB || '50',
    MAX_IMAGE_SIZE_MB: process.env.MAX_IMAGE_SIZE_MB || '10',
    MAX_AVATAR_SIZE_MB: process.env.MAX_AVATAR_SIZE_MB || '5',
    ROOM_ARCHIVE_HOURS: process.env.ROOM_ARCHIVE_HOURS || '24',
    CODE_REUSE_DAYS: process.env.CODE_REUSE_DAYS || '30',
    DEFAULT_VIEWER_LIMIT: process.env.DEFAULT_VIEWER_LIMIT || '50',
    GEO_DEFAULT_TIMER_MS: process.env.GEO_DEFAULT_TIMER_MS || '20000',
    GEO_MIN_TIMER_MS: process.env.GEO_MIN_TIMER_MS || '5000',
    GEO_DEFAULT_POINTS: process.env.GEO_DEFAULT_POINTS || '100',
    GEO_DEFAULT_WRONG_POINTS: process.env.GEO_DEFAULT_WRONG_POINTS || '0',
    JEOPARDY_DEFAULT_TIMER_MS: process.env.JEOPARDY_DEFAULT_TIMER_MS || '20000',
    JEOPARDY_BUZZER_LOCKOUT_MS: process.env.JEOPARDY_BUZZER_LOCKOUT_MS || '1000',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    BACKUP_RETENTION_DAYS: process.env.BACKUP_RETENTION_DAYS || '7',
    BACKUP_PATH: process.env.BACKUP_PATH || './storage/backups',
  };

  const result = envSchema.safeParse(raw);
  
  if (!result.success) {
    console.error('Invalid environment configuration:', result.error.flatten());
    process.exit(1);
  }

  const data = result.data;
  
  return {
    ...data,
    allowedOrigins: data.ALLOWED_ORIGINS.split(',').map(s => s.trim()),
    storagePaths: {
      root: data.STORAGE_ROOT,
      database: `${data.STORAGE_ROOT}/database`,
      uploads: `${data.STORAGE_ROOT}/uploads`,
      backups: data.BACKUP_PATH,
    },
    maxFileSizes: {
      upload: data.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
      image: data.MAX_IMAGE_SIZE_MB * 1024 * 1024,
      avatar: data.MAX_AVATAR_SIZE_MB * 1024 * 1024,
    },
  };
}

export const config = loadConfig();

// Type for use in other files
export type Config = typeof config;
