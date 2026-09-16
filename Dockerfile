# syntax=docker/dockerfile:1
FROM node:20-alpine AS base

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

RUN pnpm build --filter @quiz/server --filter @quiz/web

# ============================================================
# Runner
# ============================================================
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 quiz

# Create storage directories
RUN mkdir -p /app/storage/database /app/storage/uploads /app/storage/backups && \
    chown -R quiz:nodejs /app/storage

COPY --from=builder --chown=quiz:nodejs /app/apps/server/dist ./dist
COPY --from=builder --chown=quiz:nodejs /app/apps/web/dist ./web
COPY --from=builder --chown=quiz:nodejs /app/prisma ./prisma
COPY --from=builder --chown=quiz:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=quiz:nodejs /app/package.json ./package.json

USER quiz

EXPOSE 5173

ENV PORT=5173
ENV DATABASE_URL="file:/app/storage/database/quiz.db"
ENV STORAGE_ROOT="/app/storage"

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/api/v1/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
