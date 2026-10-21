# LifeOS images (one Dockerfile, two targets): `api` (Fastify + better-sqlite3, runs as uid 1000 so
# vault writes look like ordinary files to Syncthing and Obsidian) and `web` (nginx serving the
# built PWA under /lifeos and proxying /lifeos/api to the API). Secrets never enter an image: the
# .env.* files are excluded by .dockerignore and loaded at run time by compose `env_file`.
# It builds on amd64 and arm64 alike (a NAS builds it itself, product brief 10 §2, ADR-95): the
# native modules (better-sqlite3, argon2) come prebuilt for both, the npm and apt downloads are
# kept in BuildKit cache mounts between builds, and the runtime image has no dev dependencies.
FROM node:22-bookworm-slim AS deps
WORKDIR /repo
ENV npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false
# better-sqlite3 compiles from source when no prebuilt binary matches this Node
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt,sharing=locked \
  rm -f /etc/apt/apt.conf.d/docker-clean && apt-get update && apt-get install -y --no-install-recommends python3 make g++
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
# the commit the UI was built from (scripts/*.sh pass it; Settings → About shows it)
ARG LIFEOS_BUILD=dev
RUN npm run build -w @lifeos/shared && npm run build -w @lifeos/api && npm run build -w @lifeos/web \
  && npm prune --omit=dev
# the portable README as a page beside the app, /lifeos/guide.html (ADR-94)
COPY docker/guide.mjs docker/guide.mjs
COPY portable/README.md portable/README.md
RUN node docker/guide.mjs portable/README.md apps/web/dist/guide.html

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./
COPY --from=build /repo/packages/shared/package.json packages/shared/
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/apps/api/package.json apps/api/
COPY --from=build /repo/apps/api/dist apps/api/dist
# the copy-ready prompt Settings → Hermes fills in (ADR-88)
COPY docs/hermes-prompt.md docs/hermes-prompt.md
# the starter notes an empty notes folder gets on the first start (ADR-91)
COPY fixtures/starter-vault starter-vault
# /data is writable by whichever user the notes' owner runs it as (compose LIFEOS_UID), so a new
# volume works for uid 1000 and for anyone else; /auth too, since compose mounts the same data
# volume there unless LIFEOS_AUTH_DIR is set (ADR-90)
RUN mkdir -p /data /vault /auth && chown node:node /data /auth && chmod 0777 /data /auth
USER node
EXPOSE 8481
CMD ["node", "apps/api/dist/server.js"]

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/proxy.inc /etc/nginx/lifeos-proxy.inc
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html/lifeos
EXPOSE 8080
