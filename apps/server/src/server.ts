// ============================================================
// Online Quiz Plattform - Main Server Entry
// ============================================================

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
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
import { restoreActiveTimers } from './games/geo/index.js';

// Version aus package.json lesen (nicht hart kodiert)
const _serverDir = dirname(fileURLToPath(import.meta.url));
const serverPkg = JSON.parse(readFileSync(resolve(_serverDir, '../../../package.json'), 'utf8'));
const APP_VERSION = serverPkg.version;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV !== 'production';

const app = express();
const httpServer = createServer(app);

// Socket.IO setup
const io = new Server(httpServer, {
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
}));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser(config.sessionSecret));

// Static files (production build) – use WEB_DIST_PATH env or compute from __dirname
// __dirname = apps/server/src → apps/web/dist requires ../../../apps/web/dist
const webDistPath = process.env.WEB_DIST_PATH
  ? path.resolve(process.env.WEB_DIST_PATH)
  : path.join(__dirname, '../../../apps/web/dist');
app.use(express.static(webDistPath));

// API Routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/e2e', e2eRouter);
app.use('/api/v1/catalog', catalogRouter);
app.use('/api/v1/rooms', roomsRouter);
app.use('/api/v1/setups', setupRouter);
app.use('/api/v1/media', mediaRouter);

// Health check - /api/v1/ready (primary for k8s) and /api/v1/health (alias)
const healthHandler = async (_req: express.Request, res: express.Response) => {
  try {
    // DB connectivity check: run a simple query
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      checks: {
        db: 'ok',
      },
    });
  } catch (error) {
    logger.error('Health check failed', { error });
    res.status(503).json({
      status: 'error',
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      checks: {
        db: 'error',
      },
    });
  }
};
app.get('/api/v1/ready', healthHandler);
app.get('/api/v1/health', healthHandler);

// Legacy redirects (Kapitel 25)
app.get('/api/mod/login', (_req, res) => {
  res.redirect('/api/v1/auth/login');
});

// SPA Fallback — nur Nicht-API-Routen
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

// Start server
const PORT = config.port;

export async function start() {
  try {
    // Test database connection
    await prisma.$connect();
    logger.info('Database connected');

    // P0-16: Restauriere aktive Timer nach Server-Restart
    await restoreActiveTimers(io);

    httpServer.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`App URL: ${config.publicAppUrl}`);
    });
  } catch (error: unknown) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  await prisma.$disconnect();
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

start();

export { io };
