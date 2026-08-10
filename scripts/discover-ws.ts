// One-off manual discovery script for API_NOTES.md — not part of the app.
// Run with: PROTECT_HOST=... bun run scripts/discover-ws.ts
// Confirms the /v1/subscribe/devices websocket push behavior. Leave running
// and change a sensor value (breathe on it, cover it, etc.) to see an event.

const host = process.env.PROTECT_HOST;
const apiKey = process.env.PROTECT_API_KEY;

if (!host || !apiKey) {
  console.error("PROTECT_HOST and PROTECT_API_KEY must be set");
  process.exit(1);
}

const url = `wss://${host}/proxy/protect/integration/v1/subscribe/devices`;
console.log(`Connecting to ${url} ...`);

const ws = new WebSocket(url, {
  headers: { "X-API-KEY": apiKey },
  // @ts-expect-error bun-specific: accept self-signed console cert
  tls: { rejectUnauthorized: false },
} as any);

ws.addEventListener("open", () => console.log("connected, waiting for events (90s)..."));
ws.addEventListener("message", (ev) => console.log("event:", ev.data));
ws.addEventListener("error", (ev) => console.error("error:", ev));
ws.addEventListener("close", (ev) => console.log("closed:", ev.code, ev.reason));

setTimeout(() => {
  console.log("timeout reached, closing.");
  ws.close();
  process.exit(0);
}, 90_000);
