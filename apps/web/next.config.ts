import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // React Compiler auto-memoizes components/hooks at build time so we
  // don't hand-roll useMemo/useCallback everywhere — matters most on the
  // low-power devices (phones) this dashboard gets checked from.
  experimental: {
    reactCompiler: true,
  },

  // NOT output: "standalone" — tried and reverted (see DEPLOY.md). Its
  // pruned node_modules only preserves what Next's own bundled route code
  // needs; it doesn't keep workspace packages (@unifi-sensor-latch/engine)
  // resolvable for server.ts's own top-level imports, since server.ts
  // sits outside Next's webpack trace entirely. Confirmed live in a real
  // Docker build. The Dockerfile ships the full node_modules instead.
  //
  // The custom server (server.ts) terminates HTTPS itself with a
  // self-signed cert — see DEPLOY.md. This app is never run via bare
  // `next start`; the compiled server.ts is the production entrypoint.
};

export default nextConfig;
