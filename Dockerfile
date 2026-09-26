# Noctiv API and worker (one image; SERVICE=api|worker picks the program).
# Node 22 runs the TypeScript sources directly (type stripping); no build step.
FROM public.ecr.aws/docker/library/node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/documents/package.json packages/documents/
COPY packages/kb/package.json packages/kb/
COPY packages/llm/package.json packages/llm/
COPY packages/mail/package.json packages/mail/
COPY packages/quotes/package.json packages/quotes/
RUN pnpm install --frozen-lockfile --prod --filter "@noctiv/api..." --filter "@noctiv/worker..."

FROM public.ecr.aws/docker/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app /app
COPY apps/api/src apps/api/src
COPY apps/worker/src apps/worker/src
COPY packages/core/src packages/core/src
COPY packages/db/src packages/db/src
COPY packages/db/scripts packages/db/scripts
COPY packages/documents/src packages/documents/src
COPY packages/kb/src packages/kb/src
COPY packages/llm/src packages/llm/src
COPY packages/mail/src packages/mail/src
COPY packages/quotes/src packages/quotes/src
COPY supabase/migrations supabase/migrations
USER node
ENV SERVICE=api
EXPOSE 8080
CMD ["sh", "-c", "exec node apps/$SERVICE/src/main.ts"]
