# Known Issues

This document tracks P0/P1/P2 issues identified during Gate 1 & Gate 2 review.

## Gate 1 - P0 Blockers (Must Fix)

### CONFIG-001: Config returns uppercase env keys but server expects lowercase
**Status**: ✅ FIXED in this PR  
**Files**: `apps/server/src/config/index.ts`, `apps/server/src/server.ts`  
**Issue**: Config returned `PORT`, `SESSION_SECRET`, `PUBLIC_APP_URL` but server.ts read `config.port`, `config.sessionSecret`, `config.publicAppUrl`

### ESM-001: TypeScript config used NodeNext instead of Node16
**Status**: ✅ FIXED in this PR  
**Files**: `apps/server/tsconfig.json`, `apps/server/package.json`  
**Issue**: `type: "module"` in package.json requires Node16 module resolution. Removed `tsconfig.build.json` reference.

### BUILD-001: Build script referenced non-existent tsconfig.build.json
**Status**: ✅ FIXED in this PR  
**Files**: `apps/server/package.json`  
**Issue**: Build script `'tsc && tsc -p tsconfig.build.json'` failed because tsconfig.build.json doesn't exist.

### PORT-001: Default port was 5173 instead of 3001
**Status**: ✅ FIXED in this PR  
**Files**: `apps/server/src/config/index.ts`, `.env.example`  
**Issue**: Default port in config was 5173, should be 3001.

### SECURITY-001: SHA-256 for password hashing instead of Argon2
**Status**: ✅ FIXED in this PR  
**Files**: `prisma/seed.ts`  
**Issue**: Seed script now uses Argon2 for password hashing.

### API-001: Room creation requires gameDefinitionId but frontend sends gameSlug
**Status**: ✅ FIXED in this PR  
**Files**: `apps/server/src/http/rooms.ts`  
**Issue**: Endpoint POST /api/v1/rooms only accepted `gameDefinitionId`. Now also accepts `gameSlug` and resolves to id.

### SOCKET-001: Join endpoint missing rejoinTokenVersion
**Status**: ✅ FIXED in this PR  
**Files**: `apps/server/src/http/rooms.ts`  
**Issue**: Create participation didn't set `rejoinTokenVersion: 1`

### RANDOM-001: Room code generation using Math.random()
**Status**: ✅ FIXED in this PR  
**Files**: `apps/server/src/http/rooms.ts`  
**Issue**: Room codes now use `crypto.randomInt` instead of `Math.random()`

### HOST-PARTICIPATION-001: Host participation missing required fields
**Status**: ✅ FIXED in this PR  
**Files**: `apps/server/src/http/rooms.ts`  
**Issue**: Host participation creation was missing `rejoinToken` and `rejoinTokenVersion` fields.

### ROUTER-TYPES-001: Router type inference errors
**Status**: ✅ FIXED in this PR  
**Files**: `apps/server/src/http/*.ts`  
**Issue**: Added explicit type annotations to all router exports to avoid portable type errors.

## Gate 2 - P1 Issues (Should Fix)

### REGISTRY-001: Game registry imports non-existent geo exports
**Status**: ✅ FIXED in this PR  
**Files**: `apps/server/src/games/registry.ts`  
**Issue**: Registry was already correctly importing `handleGeoGame`, no fix needed.

### DATA-001: Prisma schema missing RoomGameState model
**Status**: ✅ VERIFIED EXISTS  
**Files**: `prisma/schema.prisma`  
**Issue**: The schema already has RoomGameState model, no fix needed.

### SEED-001: Seed game definitions use wrong field names
**Status**: ✅ FIXED in subsequent commit
**Files**: `prisma/seed.ts`
**Issue**: Seed used `estimatedMinutes` and `JSON.stringify(tags)` but schema expects `estimatedDurationMinutes` and `tags` as String array.

### SEED-002: Seed uses wrong password env variable name
**Status**: ✅ FIXED in initial commit (INITIAL_ADMIN_PASSWORD already in seed.ts)
**Files**: `prisma/seed.ts`
**Issue**: Seed reads `process.env.INITIAL_ADMIN_PASSWORD` — correct.

### TYPING-001: Timeline game manifest has 'AVANNING' typo
**Status**: ✅ FIXED in this PR  
**Files**: `packages/shared/src/index.ts`  
**Issue**: `status: 'AVANNING'` → `status: 'PLANNED'`

### VERSION-001: Health endpoint reports 0.1.0 instead of 0.2.1
**Status**: ✅ FIXED in this PR  
**Files**: `apps/server/src/server.ts`  
**Issue**: Version was '0.1.0', updated to '0.2.1'

### ENV-001: .env.example missing WEB_DIST_PATH
**Status**: ✅ FIXED in this PR  
**Files**: `.env.example`  
**Issue**: Added `WEB_DIST_PATH=./apps/web/dist` to .env.example

### LOGGER-001: Logger references config.LOG_LEVEL instead of config.logLevel
**Status**: ✅ FIXED in this PR  
**Files**: `apps/server/src/observability/logger.ts`  
**Issue**: Fixed reference to lowercase `logLevel`.

### MANIFEST-001: Missing hasCamera property in GAME_MANIFESTS
**Status**: ✅ FIXED in this PR  
**Files**: `packages/shared/src/index.ts`  
**Issue**: Allgemeinwissen game manifest missing `hasCamera: false`.

## Gate 2 - P2 Issues (Nice to Fix)

### SOCKET-002: handleRoomSubscription in room.ts returns undefined from .then()
**Status**: ⚠️ STILL NEEDS FIX  
**Files**: `apps/server/src/sockets/room.ts`  
**Issue**: The function returns the result of a .then() call instead of properly awaiting.

### REGISTRY-002: Other games (jeopardy, timeline, etc.) are stubs
**Status**: 🔶 DEFERRED  
**Files**: `apps/server/src/games/*.ts`  
**Issue**: Only geo game is fully implemented.

### TEST-001: Web tests need jsdom dependency
**Status**: ⚠️ STILL NEEDS FIX  
**Files**: `apps/web/package.json`  
**Issue**: jsdom not installed for vitest tests.

## Remaining Work

- [ ] Fix prisma/seed.ts field names (`estimatedMinutes` → `estimatedDurationMinutes`, tags handling)
- [ ] Fix prisma/seed.ts to use `INITIAL_ADMIN_PASSWORD` env var
- [ ] Fix handleRoomSubscription async/await issue
- [ ] Add jsdom to web package.json devDependencies
- [ ] Run full typecheck and fix errors

## Notes

- Server version bumped to 0.2.1
- Package.json version bumped to 0.2.1
- README updated to show honest "Prototyp" status
- argon2 installed at workspace root for seed script
- Database successfully seeded
- Branch pushed to `gate-1-2-fixes`
