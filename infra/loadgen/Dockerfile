# Load generator. Build context is the REPO ROOT.
# syntax=docker/dockerfile:1

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY infra/loadgen/package.json infra/loadgen/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @chainstake/loadgen...

COPY . .
USER node
CMD ["pnpm", "--filter", "@chainstake/loadgen", "start"]
