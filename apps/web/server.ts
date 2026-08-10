import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
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

  const dev = process.env.NODE_ENV !== "production";
  const port = Number(process.env.PORT ?? 8443);

  const engine = getEngine();
  await engine.boot();

  const app = next({ dev });
  const handle = app.getRequestHandler();
  await app.prepare();

  const certPath = process.env.TLS_CERT_PATH;
  const keyPath = process.env.TLS_KEY_PATH;
  if (!certPath || !keyPath) {
    throw new Error("TLS_CERT_PATH and TLS_KEY_PATH must be set — see DEPLOY.md for cert generation.");
  }

  const httpsOptions = {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };

  createHttpsServer(httpsOptions, (req, res) => handle(req, res)).listen(port, () => {
    console.log(`[server] listening on https://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error("[server] fatal error during boot", err);
  process.exit(1);
});
