# syntax=docker/dockerfile:1
FROM node:22-alpine AS base

# ============================================================
# Dependencies
# ============================================================
FROM base AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/*/package.json packages/
COPY apps/*/package.json apps/

RUN npm install -g pnpm@9 && \
    pnpm install --frozen-lockfile

# ============================================================
# Builder
# ============================================================
FROM deps AS builder
WORKDIR /app

COPY . .

# prisma generate: needed for compiled code
# prisma migrate deploy: REMOVED from build — runs at container startup instead
RUN pnpm exec prisma generate --schema=./prisma/schema.prisma && \
    pnpm --filter @quiz/server build && \
    pnpm --filter @quiz/web build

# ============================================================
# Runner
# ============================================================
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_URL="file:/app/storage/database/quiz.db"
ENV SESSION_SECRET="${SESSION_SECRET:-change-me-in-production-use-32-chars-minimum}"
ENV INITIAL_ADMIN_PASSWORD="${INITIAL_ADMIN_PASSWORD:-change-me-in-production}"
ENV STORAGE_ROOT="/app/storage"
ENV WEB_DIST_PATH="/app/web"

# Copy compiled server + web + prisma schema + prisma client binaries
# These directories are created by the builder stage
COPY --from=builder --chown=nodejs:nodejs /app/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=nodejs:nodejs /app/apps/web/dist ./apps/web/dist
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nodejs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json

EXPOSE 3001

# Migration runs at container startup (not during build)
# Image can be built without a running database
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node apps/server/dist/server.js"]
