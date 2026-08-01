# Multi-stage build for the indexer. Build context is the REPO ROOT (see infra/docker-compose.yml).
# syntax=docker/dockerfile:1

# ── Base: pnpm on Node 22 ────────────────────────────────────
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ── Dependencies (cached on lockfile) ────────────────────────
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/indexer/package.json apps/indexer/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @ledgerline/indexer...

# ── Build ────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN pnpm --filter @ledgerline/indexer... build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @ledgerline/indexer deploy --prod /app

# ── Runtime (slim, non-root) ─────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
