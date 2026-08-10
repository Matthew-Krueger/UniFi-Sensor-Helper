# Floats on the "1" major tag rather than an exact patch pin (project
# preference — see DEPLOY.md's "Node/Bun version parity" section) so
# rebuilding the image picks up Bun patch releases automatically. Alpine
# variant: much smaller than -slim (musl libc instead of glibc),
# officially published by oven, and this app has no native npm addons
# that would care — bun:sqlite is built into the Bun binary itself, not a
# native module.
FROM oven/bun:1-alpine AS base
WORKDIR /repo

FROM base AS deps
COPY package.json bun.lock .bun-version ./
COPY apps/web/package.json apps/web/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile

FROM base AS build
# Bun's install hoists dependencies inconsistently per workspace on this
# repo's dependency graph — confirmed live: packages/engine/node_modules
# (drizzle-orm) and packages/shared/node_modules (zod) each end up with
# their own node_modules, not just the root and apps/web. Copying only
# two selective paths (the original approach) silently dropped those,
# breaking `next build`'s module resolution for the workspace packages.
# Copying the whole deps output avoids needing to track every workspace's
# hoisting outcome by hand.
COPY --from=deps /repo ./
COPY . .
RUN cd apps/web && bun run build

FROM base AS runtime
ENV NODE_ENV=production
# oven/bun images already ship a non-root "bun" user (uid 1000) — no need
# to create our own. CLAUDE.md's process-isolation requirement (dedicated
# unprivileged user) is about the systemd/host level for a bare-process
# deploy; inside the container, reusing the image's own user is simpler
# and just as unprivileged.

# Full node_modules, not Next's standalone-pruned output (see
# next.config.ts) — confirmed live that the pruned tree doesn't preserve
# @unifi-sensor-latch/engine (or `next` itself, reliably) as something
# server.ts's own top-level imports can resolve, since server.ts is never
# part of Next's own webpack trace. This is the real, complete tree the
# build stage already proved works (it's what `bun run build` itself ran
# against).
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /repo/apps/web/.next ./apps/web/.next
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/apps/web/server.ts ./apps/web/server.ts
COPY --from=build /repo/apps/web/package.json ./apps/web/package.json

RUN mkdir -p /repo/data && chown -R bun:bun /repo
USER bun

EXPOSE 8443
WORKDIR /repo/apps/web
CMD ["bun", "run", "server.ts"]
