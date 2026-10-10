// ============================================================
// Online Quiz Plattform - Main Server Entry
// Uses createApp() factory from app.ts
// ============================================================

import { createApp } from './app.js';
import { prisma } from './persistence/prisma.js';
import { restoreActiveTimers } from './games/geo/index.js';
import { migrateCanonicalSlugsOnStartup } from './persistence/canonicalSlugMigration.js';
import { cleanupOrphanedTempAssets } from './media/lifecycle.js';
import { logger } from './observability/logger.js';
import { config } from './config/index.js';

const { io, httpServer } = createApp();

// Start server
export async function start() {
  try {
    await prisma.$connect();
    logger.info('Database connected');

    // Versionierte, idempotente Slug-Migration auf die kanonischen
    // Spielidentitäten (Regelwerk §5.22/§5.23/§14). Muss VOR der
    // Timer-Restoration laufen, damit aktive Räume den kanonischen Slug tragen.
    await migrateCanonicalSlugsOnStartup(prisma);

    // P0-16: Restauriere aktive Timer nach Server-Restart
    await restoreActiveTimers(io);

    // PR11-Nacharbeit E: befristete Bereinigung verwaister tmp-Medien.
    // NUR ungebundene tmp-Assets (roomId 'tmp-<Host>'), die in KEINEM
    // Raumsnapshot referenziert sind UND älter als 24h. Aktive +
    // historisch benötigte Bilder bleiben damit geschützt. Fail-tolerant
    // (ein Fehlschlag blockiert den Start NICHT). BEGRENZT: das ist kein
    // allgemeiner Storage-GC, sondern die BETA-Deckung für den
    // Setup-Abbruch- bzw. Prozessunterbrechungsfall (Doku).
    try {
      await cleanupOrphanedTempAssets(prisma, 24 * 60 * 60 * 1000);
    } catch (cleanupError) {
      logger.warn('Orphan-Temp-Cleanup beim Start fehlgeschlagen (Server läuft weiter)', { error: cleanupError });
    }

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
