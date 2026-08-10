import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import next from "next";
import { getEngine } from "@unifi-sensor-latch/engine";

// Custom server entrypoint — CLAUDE.md "the engine must not depend on the
// UI being open". The latch engine boots here, once, before the HTTPS
// listener comes up. Route Handlers (app/api/**) call into the resulting
// singleton; they never instantiate or own it.
//
// `next start` alone does NOT run this file — production deploys must
// invoke the compiled version of this file directly (see DEPLOY.md).

declare global {
  // eslint-disable-next-line no-var
  var __serverBooted: boolean | undefined;
}

async function main() {
  // globalThis guard: Next.js dev-mode HMR re-runs module-level code, but
  // this file is the process entrypoint (bun run server.ts), not a module
  // Next re-imports — so in practice this guards against server.ts being
  // required twice in the same process rather than a normal HMR path. Kept
  // here as defense-in-depth alongside the engine's own globalThis guard.
  if (globalThis.__serverBooted) return;
  globalThis.__serverBooted = true;

  // The process starts with cwd = repo root (package.json's dev/start
  // scripts run `bun run apps/web/server.ts` from there), which is what
  // .env/DATABASE_PATH/TLS_*_PATH are written relative to. Resolve the TLS
  // paths to absolute *before* the chdir below, so they still work once
  // cwd changes. DATABASE_PATH doesn't need this — the engine reads it
  // during boot(), below, while cwd is still the repo root.
  const rootCwd = process.cwd();
  const certPath = process.env.TLS_CERT_PATH;
  const keyPath = process.env.TLS_KEY_PATH;
  if (!certPath || !keyPath) {
    throw new Error("TLS_CERT_PATH and TLS_KEY_PATH must be set — see DEPLOY.md for cert generation.");
  }
  const httpsOptions = {
    cert: readFileSync(resolve(rootCwd, certPath)),
    key: readFileSync(resolve(rootCwd, keyPath)),
  };

  const dev = process.env.NODE_ENV !== "production";
  const port = Number(process.env.PORT ?? 8443);

  const engine = getEngine();
  await engine.boot();

  // Next.js (and, underneath it, Tailwind's content-glob resolution)
  // resolves relative to process.cwd(), not the `dir` option below — so
  // chdir into apps/web now that .env-relative and TLS paths are already
  // resolved, restoring the cwd Next actually expects. Without this, the
  // production build silently ships with no Tailwind-generated CSS (the
  // bug this comment is here to prevent someone from reintroducing).
  process.chdir(import.meta.dir);

  const app = next({ dev, dir: import.meta.dir });
  const handle = app.getRequestHandler();
  await app.prepare();

  createHttpsServer(httpsOptions, (req, res) => handle(req, res)).listen(port, () => {
    console.log(`[server] listening on https://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error("[server] fatal error during boot", err);
  process.exit(1);
});
