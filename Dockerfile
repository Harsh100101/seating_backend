# =============================================================================
# Shared base: install Prisma's OpenSSL runtime once for both stages.
# =============================================================================
FROM node:20-bookworm-slim AS base

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Stage 1: Build & Compile
# =============================================================================
FROM node:20-bookworm AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

COPY . .

RUN DATABASE_URL=mongodb://127.0.0.1:27017/build_only npx prisma generate
RUN npm run build

# Stage 2: Production Runner
# =============================================================================
FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs fastify

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p /app/uploads/floors && chown -R fastify:nodejs /app/uploads

USER fastify

EXPOSE 3001

CMD ["node", "dist/index.js"]
