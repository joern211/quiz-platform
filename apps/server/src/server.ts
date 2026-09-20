// ============================================================
// Online Quiz Plattform - Main Server Entry
// Uses createApp() factory from app.ts
// ============================================================

import { createApp } from './app.js';
import { prisma } from './persistence/prisma.js';
import { restoreActiveTimers } from './games/geo/index.js';
import { logger } from './observability/logger.js';
import { config } from './config/index.js';

const { io, httpServer } = createApp();

// Start server
export async function start() {
  try {
    await prisma.$connect();
    logger.info('Database connected');

    // P0-16: Restauriere aktive Timer nach Server-Restart
    await restoreActiveTimers(io);

    httpServer.listen(config.port, () => {
      logger.info(`Server running on port ${config.port}`);
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
