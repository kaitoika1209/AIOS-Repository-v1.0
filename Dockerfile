# AIOS — API, Worker, and web application.
#
# One Dockerfile, three targets. They share a build so the workspace is compiled
# once; `--target` selects what the image runs.
#
#     docker build --target api    -t aios-api    .
#     docker build --target worker -t aios-worker .
#     docker build --target web    -t aios-web    .
#
# The API and the Worker are separate images on purpose. The observability
# baseline requires "separate HTTP liveness/readiness, Worker liveness/readiness",
# and `chooseWorkerMode` refuses to drain the Outbox inside an API process
# outside development — so deploying only the API leaves Memory generation
# stopped rather than silently coupling it to API replica count.
#
# NOT YET BUILT. This was written where the container registry is unreachable,
# so it has never been through `docker build`. What *has* been verified, on the
# host and outside any container, is the part that was actually broken: each
# `CMD` below was run as plain `node` against PostgreSQL, and each does what it
# claims — the API serves, the Worker drains, the migrator takes an empty
# database to the documented schema. The remaining unknowns are the image
# mechanics: the layer copy, `pnpm install --frozen-lockfile` under this base,
# and whether `pnpm run build` completes with the build context as given. Treat
# a first build as part of the work, not as a formality.

# --- build ------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable

# Manifests first, so a dependency install is cached independently of source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/types/package.json packages/types/
COPY packages/domain/package.json packages/domain/
COPY packages/application/package.json packages/application/
COPY packages/persistence/package.json packages/persistence/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# --- api --------------------------------------------------------------------
FROM node:22-slim AS api
WORKDIR /app/apps/api
ENV NODE_ENV=production

COPY --from=build /app /app

# `node` directly, not `pnpm exec node`. A package-manager wrapper becomes PID 1
# and receives the orchestrator's SIGTERM itself; the Node process underneath
# never sees it and is killed on the timeout instead. That is not theoretical —
# signalling the wrapper during development left the Worker's shutdown handler
# unrun until the signal was sent to the Node process directly.
#
# It resolves because each workspace package exports `default: ./dist/index.js`
# alongside the `development` condition that source-reading runtimes ask for.
# See "Source or Build" in CONTRIBUTING.md.
#
# `migrations/` travels in the image because the entry point may run them, and a
# migration chain that is not in the image is one that can drift from the code it
# is meant to accompany:
#
#     node dist/migrate.js --status   # what would be applied
#     node dist/migrate.js            # apply
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]

# --- worker -----------------------------------------------------------------
FROM node:22-slim AS worker
WORKDIR /app/apps/api
ENV NODE_ENV=production

COPY --from=build /app /app

# No port. The Worker's liveness and readiness endpoints are baseline item 8 and
# are not built yet; until they are, an orchestrator can only observe the
# process, which the release-readiness document records as an open gap rather
# than something this image quietly papers over.
#
# Give it a shutdown grace period longer than one drain. It finishes the batch in
# flight on SIGTERM rather than abandoning claimed messages to their lease
# timeout, which is the whole point of handling the signal.
USER node
CMD ["node", "dist/worker.js"]

# --- web --------------------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable
COPY --from=build /app ./

USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@aios/web", "start"]
