# Pin the exact Bun version so the image matches local `bun run dev` — see
# .bun-version and DEPLOY.md. Update both together.
FROM oven/bun:1.3.14-slim AS base
WORKDIR /repo

FROM base AS deps
COPY package.json bun.lock .bun-version ./
COPY apps/web/package.json apps/web/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile

FROM base AS build
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY . .
RUN cd apps/web && bun run build

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup --system latch && adduser --system --ingroup latch latch

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/web/.next/standalone ./apps/web
COPY --from=build /repo/apps/web/.next/static ./apps/web/apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/apps/web/server.ts ./apps/web/server.ts
COPY --from=build /repo/apps/web/package.json ./apps/web/package.json

RUN mkdir -p /repo/data && chown -R latch:latch /repo
USER latch

EXPOSE 8443
WORKDIR /repo/apps/web
CMD ["bun", "run", "server.ts"]
