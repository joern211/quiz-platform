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

import { config } from './config/index.js';
import { authRouter } from './http/auth.js';
import { catalogRouter } from './http/catalog.js';
import { roomsRouter } from './http/rooms.js';
import { setupRouter } from './http/setups.js';
import { mediaRouter } from './http/media.js';
import { setupSocketHandlers } from './sockets/index.js';
import { prisma } from './persistence/prisma.js';
import { logger } from './observability/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);

// Socket.IO setup
const io = new Server(httpServer, {
  cors: {
    origin: config.allowedOrigins,
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

// Middleware
app.use(cors({ origin: config.allowedOrigins, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser(config.sessionSecret));

// Static files (production build)
const webDistPath = path.join(__dirname, '../../apps/web/dist');
app.use(express.static(webDistPath));

// API Routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/catalog', catalogRouter);
app.use('/api/v1/rooms', roomsRouter);
app.use('/api/v1/setups', setupRouter);
app.use('/api/v1/media', mediaRouter);

// Health check
app.get('/api/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// Legacy redirects (Kapitel 25)
app.get('/api/mod/login', (_req, res) => {
  res.redirect('/api/v1/auth/login');
});

// SPA Fallback
app.get('*', (_req, res) => {
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

async function start() {
  try {
    // Test database connection
    await prisma.$connect();
    logger.info('Database connected');
    
    httpServer.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`App URL: ${config.publicAppUrl}`);
    });
  } catch (error) {
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
