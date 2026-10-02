# Noctiv API and worker (one image; SERVICE=api|worker picks the program).
# Node 22 runs the TypeScript sources directly (type stripping); no build step.
#
# Every workspace package is copied by pattern, never by name, so a new package under
# packages/ or apps/ cannot be forgotten (that once took the API down: ERR_MODULE_NOT_FOUND).
# pnpm installs only what @noctiv/api and @noctiv/worker depend on, and scripts/docker-smoke.sh
# (run in CI) builds this image and boots both services.

# Stage 1: only the package.json files, in their folders, so the dependency layer is cached
# until a dependency changes.
FROM public.ecr.aws/docker/library/node:22-alpine AS manifests
WORKDIR /src
COPY apps apps
COPY packages packages
RUN mkdir /out && find apps packages -maxdepth 2 -name package.json | tar -cf - -T - | tar -xf - -C /out

FROM public.ecr.aws/docker/library/node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=manifests /out ./
RUN pnpm install --frozen-lockfile --prod --filter "@noctiv/api..." --filter "@noctiv/worker..."

FROM public.ecr.aws/docker/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app /app
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY packages packages
COPY supabase/migrations supabase/migrations
USER node
ENV SERVICE=api
EXPOSE 8080
CMD ["sh", "-c", "exec node apps/$SERVICE/src/main.ts"]
