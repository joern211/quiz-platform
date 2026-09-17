// Integration test skeleton for rooms HTTP API
// These tests require a running server or a test database.
// Currently this is a placeholder documenting what needs to be tested.

import { describe, it } from 'vitest';

/**
 * Integration Test Plan for Rooms API
 *
 * Prerequisites:
 * - Running test server on port 3001 (or TEST_PORT env var)
 * - Test database with Prisma migrations applied
 * - Test fixtures: admin user, game definition
 *
 * Tests to implement:
 *
 * 1. POST /api/v1/rooms — Create room
 *    - Requires authenticated session
 *    - Validates roomName is required
 *    - Validates gameSlug or gameDefinitionId
 *    - Returns 201 with { success: true, data: { code, roomId } }
 *    - Returns 401 without session
 *
 * 2. GET /api/v1/rooms/public — List public rooms
 *    - Returns 200 with array of RoomSummary objects
 *    - Only shows LOBBY/RUNNING rooms
 *    - Limits to 50 most recent
 *
 * 3. GET /api/v1/rooms/:code — Get room details
 *    - Returns 200 with room data + players
 *    - Returns 404 for unknown code
 *    - Hides non-public rooms from unauthenticated users
 *
 * 4. POST /api/v1/rooms/:code/join — Join room
 *    - Creates participation record
 *    - Returns 201 with { participationId, rejoinToken, role, roomCode }
 *    - Returns 400 if room is not joinable
 *    - Returns 403 for wrong PIN
 *    - Returns 400 if room is full
 *
 * Implementation options:
 * - Use supertest + an Express app instance
 * - Or use Playwright for full HTTP integration
 * - Use a separate test database (DATABASE_URL override)
 */

describe('Rooms API integration tests (placeholder)', () => {
  // Skeleton: real implementation requires test server or supertest setup

  it.todo('POST /api/v1/rooms — should create room with valid session');
  it.todo('POST /api/v1/rooms — should reject unauthenticated request');
  it.todo('POST /api/v1/rooms — should reject missing roomName');
  it.todo('POST /api/v1/rooms — should reject missing game');
  it.todo('GET /api/v1/rooms/public — should list public rooms');
  it.todo('GET /api/v1/rooms/:code — should return room details');
  it.todo('GET /api/v1/rooms/:code — should return 404 for unknown code');
  it.todo('POST /api/v1/rooms/:code/join — should create participation');
  it.todo('POST /api/v1/rooms/:code/join — should reject wrong PIN');
  it.todo('POST /api/v1/rooms/:code/join — should reject when room is full');
});
