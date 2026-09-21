# Multi-stage build for the indexer. Build context is the REPO ROOT (see infra/docker-compose.yml).
# syntax=docker/dockerfile:1

# ── Base: pnpm on Node 22 ────────────────────────────────────
FROM node:25-slim AS base
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
# --legacy: pnpm 10 refuses to deploy a package with workspace dependencies unless the whole repo
# sets inject-workspace-packages=true, which would change how every workspace links
# @ledgerline/shared in development. The indexer only imports types from it (erased at compile
# time), so the pre-v10 deploy behaviour is all this image needs.
# TODO(Block 2.7): the first runtime import from @ledgerline/shared (the generated ABIs) breaks this
# image — the package's `main` is src/index.ts, which Node cannot run. Build shared to JS first.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @ledgerline/indexer deploy --prod --legacy /app

# ── Runtime (slim, non-root) ─────────────────────────────────
FROM node:25-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
