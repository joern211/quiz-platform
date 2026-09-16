// ============================================================
// Simple Server Runner
// ============================================================

import './config/index.ts';
import './persistence/prisma.ts';
import './observability/logger.ts';
import './http/auth.ts';
import './http/catalog.ts';
import './http/rooms.ts';
import './http/setups.ts';
import './http/media.ts';
import './sockets/index.ts';
import './sockets/room.ts';
import './sockets/player.ts';
import './sockets/lobby.ts';
import './sockets/game.ts';
import './games/geo/index.ts';
import './games/jeopardy/index.ts';
import './games/weristdas/index.ts';
import './games/timeline/index.ts';
import './games/luegen/index.ts';
import './games/song/index.ts';
import './games/registry.ts';
import './server.ts';
