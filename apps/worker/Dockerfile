FROM node:22.17.1-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @aios/worker... build
RUN pnpm deploy --filter @aios/worker --prod /runtime

FROM node:22.17.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --system --uid 10001 --create-home aios
COPY --from=build --chown=aios:aios /runtime ./
USER aios
CMD ["node", "dist/main.js"]

