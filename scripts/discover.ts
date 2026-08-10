// One-off manual discovery script for API_NOTES.md — not part of the app.
// Run with: bun run scripts/discover.ts
// Reads PROTECT_API_KEY / PROTECT_HOST from process.env (Bun auto-loads .env).

const host = process.env.PROTECT_HOST;
const apiKey = process.env.PROTECT_API_KEY;

if (!host || !apiKey) {
  console.error("PROTECT_HOST and PROTECT_API_KEY must be set in .env");
  process.exit(1);
}

const base = `https://${host}/proxy/protect/integration`;

async function call(path: string) {
  const res = await fetch(`${base}${path}`, {
    headers: { "X-API-KEY": apiKey! },
    // @ts-expect-error bun-specific: accept self-signed console cert
    tls: { rejectUnauthorized: false },
  });
  const text = await res.text();
  console.log(`\n=== ${path} (${res.status}) ===`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

await call("/v1/meta/info");
await call("/v1/sensors");
