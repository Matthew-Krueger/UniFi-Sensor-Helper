import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The custom server (server.ts) terminates HTTPS itself with a
  // self-signed cert — see DEPLOY.md. This app is never run via bare
  // `next start`; the compiled server.ts is the production entrypoint.
};

export default nextConfig;
