# syntax=docker/dockerfile:1.7
# Production image for agenticweb (Next.js standalone output). Targets: `runner` (default, serves traffic)
# and `migrate` (one-shot `prisma migrate deploy`, run as a release/pre-deploy job — never on app start).
ARG NODE_IMAGE=node:24.22.2-alpine3.23

# ---- deps: install with the lockfile only (cache-friendly layer) ----
FROM ${NODE_IMAGE} AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
# prisma/ + prisma.config.ts are needed because `postinstall` runs `prisma generate`.
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm build && mkdir -p public

# ---- migrate: one-shot job image (has the Prisma CLI; runs as non-root) ----
FROM build AS migrate
ENV NODE_ENV=production
USER node
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# ---- runner: minimal, non-root, no dev dependencies, no source ----
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# The runtime only needs `node`: drop the bundled package managers (npm/yarn/corepack) to shrink the attack surface
# (the base image's npm carries its own HIGH CVEs that never run in production).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
# Liveness only (no DB dependency). Readiness (/api/ready) gates traffic at the orchestrator.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
