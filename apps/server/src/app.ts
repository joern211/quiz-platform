// ============================================================
// App Factory — Express app + Socket.IO, no server listen
// Used by server.ts (production) and tests (supertest)
// ============================================================

import express, { type Express, type RequestHandler } from 'express';
import { createServer, type Server as HttpServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';

import { config } from './config/index.js';
import { authRouter } from './http/auth.js';
import { e2eRouter } from './http/e2e.js';
import { catalogRouter } from './http/catalog.js';
import { roomsRouter } from './http/rooms.js';
import { setupRouter } from './http/setups.js';
import { mediaRouter } from './http/media.js';
import { setupSocketHandlers } from './sockets/index.js';
import { prisma } from './persistence/prisma.js';
import { logger } from './observability/logger.js';

export interface AppFactoryResult {
  app: Express;
  io: SocketIO;
  httpServer: HttpServer;
  // Version string from package.json
  version: string;
}

// Version from package.json (read once, exported for tests)
function getAppVersion(): string {
  const _serverDir = dirname(fileURLToPath(import.meta.url));
  const serverPkg = JSON.parse(readFileSync(resolve(_serverDir, '../../../package.json'), 'utf8'));
  return serverPkg.version;
}

export function createApp(): AppFactoryResult {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // Read live so NODE_ENV can be overridden between test runs
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isDev = nodeEnv !== 'production';
  const APP_VERSION = getAppVersion();

  const app = express();
  const httpServer = createServer(app);

  // Socket.IO setup
  const io = new SocketIO(httpServer, {
    cors: {
      origin: isDev ? '*' : config.allowedOrigins,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Middleware
  app.use(cors({
    origin: isDev ? '*' : config.allowedOrigins,
    credentials: true,
    optionsSuccessStatus: 200,
  }) as RequestHandler);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser(config.sessionSecret) as RequestHandler);

  // Static files (production build)
  const webDistPath = process.env.WEB_DIST_PATH
    ? path.resolve(process.env.WEB_DIST_PATH)
    : path.join(__dirname, '../../../apps/web/dist');
  app.use(express.static(webDistPath));

  // API Routes
  app.use('/api/v1/auth', authRouter);
  // E2E test helpers — only mounted in development
  // In production they must not be reachable at all (no route registration)
  if (process.env.NODE_ENV !== 'production') {
    app.use('/api/v1/e2e', e2eRouter);
  }
  app.use('/api/v1/catalog', catalogRouter);
  app.use('/api/v1/rooms', roomsRouter);
  app.use('/api/v1/setups', setupRouter);
  app.use('/api/v1/media', mediaRouter);

  // Health check
  const healthHandler: RequestHandler = async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        status: 'ok',
        version: APP_VERSION,
        timestamp: new Date().toISOString(),
        checks: { db: 'ok' },
      });
    } catch (error) {
      logger.error('Health check failed', { error });
      res.status(503).json({
        status: 'error',
        version: APP_VERSION,
        timestamp: new Date().toISOString(),
        checks: { db: 'error' },
      });
    }
  };
  app.get('/api/v1/ready', healthHandler);
  app.get('/api/v1/health', healthHandler);

  // Legacy redirects
  app.get('/api/mod/login', (_req, res) => {
    res.redirect('/api/v1/auth/login');
  });

  // SPA Fallback
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const indexPath = path.join(webDistPath, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        res.status(200).send('<h1>Online Quiz Plattform</h1><p>Build the web app first: pnpm build</p>');
      }
    });
  });

  // Socket handlers
  setupSocketHandlers(io);

  // Error handling
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Ein unerwarteter Fehler ist aufgetreten.' },
    });
  });

  return { app, io, httpServer, version: APP_VERSION };
}
