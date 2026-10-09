# syntax=docker/dockerfile:1.7
# Multi-stage: the runtime image carries no compilers, no sources and no dev deps.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --workspaces --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @pos/shared && npm run build -w @pos/api
# Drop dev dependencies before they are copied into the runtime image.
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:22-bookworm-slim AS runtime
# postgresql-client supplies pg_dump for the nightly backup job.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Run as an unprivileged user; the node image already provides uid/gid 1000.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/drizzle ./apps/api/drizzle
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json

RUN mkdir -p /app/backups && chown node:node /app/backups
USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards signals so graceful shutdown actually works.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
