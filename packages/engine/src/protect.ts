import type { Metric, Reading, Sensor } from "@unifi-sensor-latch/shared";

// UniFi Protect integration API client — see API_NOTES.md for the endpoints
// this relies on and how each was confirmed. Hand-rolled rather than an
// npm dependency: no actively maintained TS/Node client was found, and the
// surface used here (list sensors, subscribe to device deltas, POST an
// alarm-manager webhook) is small.

export interface RawSensor {
  id: string;
  name: string | null;
  stats: {
    light?: { value: number | null };
    humidity?: { value: number | null };
    temperature?: { value: number | null };
  };
  lightSettings?: { isEnabled: boolean };
  humiditySettings?: { isEnabled: boolean };
  temperatureSettings?: { isEnabled: boolean };
  leakSettings?: { isInternalEnabled: boolean; isExternalEnabled: boolean };
  leakDetectedAt?: number | null;
  externalLeakDetectedAt?: number | null;
}

export interface ProtectConfig {
  host: string;
  apiKey: string;
}

function baseUrl(config: ProtectConfig): string {
  return `https://${config.host}/proxy/protect/integration`;
}

// Bun-specific fetch/WebSocket option to accept the console's self-signed
// cert — confirmed necessary live, see API_NOTES.md "Auth" section. This is
// about the outbound connection to the Protect console, unrelated to this
// app's own inbound HTTPS cert (CLAUDE.md process isolation).
const insecureTls = { tls: { rejectUnauthorized: false } };

// An unreachable/blackholed host (wrong IP, firewalled) otherwise hangs
// the request for the OS's TCP connect timeout — often a minute or more —
// which blocks whatever awaited this (e.g. POST /api/consoles, so the "Add
// console" button just spins). Every call gets a hard timeout instead of
// relying on the caller to notice.
const DEFAULT_TIMEOUT_MS = 8000;

async function protectFetch(
  config: ProtectConfig,
  path: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(`${baseUrl(config)}${path}`, {
      ...rest,
      headers: { "X-API-KEY": config.apiKey, ...rest.headers },
      signal: AbortSignal.timeout(timeoutMs),
      ...insecureTls,
    } as RequestInit);
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`Protect API ${path} timed out after ${timeoutMs}ms — is the host reachable?`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Protect API ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res;
}

// Confirms the console is reachable and the API key is valid before the
// engine commits to booting the ingest websocket. latencyMs is a real
// measured round-trip, not a placeholder — the Protect API doesn't expose
// its own latency/CPU/memory (checked against the live OpenAPI spec), so
// this is the one honest "how's the console doing" number available.
export async function checkConnection(config: ProtectConfig): Promise<{ applicationVersion: string; latencyMs: number }> {
  const start = Date.now();
  const res = await protectFetch(config, "/v1/meta/info");
  const latencyMs = Date.now() - start;
  const body = (await res.json()) as { applicationVersion: string };
  return { applicationVersion: body.applicationVersion, latencyMs };
}

export async function fetchRawSensors(config: ProtectConfig): Promise<RawSensor[]> {
  const res = await protectFetch(config, "/v1/sensors");
  return (await res.json()) as RawSensor[];
}

// Which metrics a sensor actually exposes — drives Sensor.metrics
// (SPEC.md section 4) so the UI only offers latches for metrics the
// physical device supports, rather than assuming every sensor has every
// metric. See API_NOTES.md's GET /v1/sensors notes.
function enabledMetrics(raw: RawSensor): Metric[] {
  const metrics: Metric[] = [];
  if (raw.lightSettings?.isEnabled) metrics.push("lux");
  if (raw.temperatureSettings?.isEnabled) metrics.push("temperature");
  if (raw.humiditySettings?.isEnabled) metrics.push("humidity");
  if (raw.leakSettings?.isInternalEnabled || raw.leakSettings?.isExternalEnabled) metrics.push("leak");
  return metrics;
}

// consoleId is intentionally omitted — the caller (singleton.ts) knows
// which console this sensor came from; this function is console-agnostic.
export function rawSensorToSensor(raw: RawSensor): Omit<Sensor, "consoleId"> {
  return { id: raw.id, name: raw.name ?? raw.id, metrics: enabledMetrics(raw) };
}

// leak has no continuous value like the other three stats — it's two
// nullable "detected at" timestamps. Modeled as a synthetic 0/1 reading so
// the same above/below-threshold latch state machine applies without a
// special case (see API_NOTES.md discrepancy note).
function leakValue(raw: RawSensor): number {
  return raw.leakDetectedAt != null || raw.externalLeakDetectedAt != null ? 1 : 0;
}

// Converts a (possibly partial, per the websocket delta shape) raw sensor
// payload into zero or more Readings — one per metric present in the
// payload. `timestamp` is passed in rather than read from the payload since
// Protect's delta messages don't carry one; the engine stamps arrival time.
export function rawSensorToReadings(sensorId: string, raw: Partial<RawSensor>, timestamp: number): Reading[] {
  const readings: Reading[] = [];
  if (raw.stats?.light?.value != null) {
    readings.push({ sensorId, metric: "lux", value: raw.stats.light.value, timestamp });
  }
  if (raw.stats?.temperature?.value != null) {
    readings.push({ sensorId, metric: "temperature", value: raw.stats.temperature.value, timestamp });
  }
  if (raw.stats?.humidity?.value != null) {
    readings.push({ sensorId, metric: "humidity", value: raw.stats.humidity.value, timestamp });
  }
  if (raw.leakDetectedAt !== undefined || raw.externalLeakDetectedAt !== undefined) {
    readings.push({ sensorId, metric: "leak", value: leakValue(raw as RawSensor), timestamp });
  }
  return readings;
}

interface DeviceEventMessage {
  type: "add" | "update" | "remove";
  item: Partial<RawSensor> & { id: string; modelKey: string };
}

export interface DeviceSubscription {
  close(): void;
}

// Subscribes to /v1/subscribe/devices (confirmed live, see API_NOTES.md) and
// calls onReading for every metric-bearing delta on a "sensor" device.
// Reconnects with exponential backoff on close/error rather than relying on
// an external scheduler — the engine is a persistent process, per CLAUDE.md
// "don't reach for cron ... those live inside the engine as timers".
export function subscribeDevices(
  config: ProtectConfig,
  onReading: (reading: Reading) => void,
  onStatusChange?: (status: "connected" | "disconnected") => void
): DeviceSubscription {
  let closed = false;
  let ws: WebSocket | null = null;
  let backoffMs = 1000;
  const maxBackoffMs = 30_000;

  function connect() {
    if (closed) return;
    const url = `wss://${config.host}/proxy/protect/integration/v1/subscribe/devices`;
    ws = new WebSocket(url, {
      headers: { "X-API-KEY": config.apiKey },
      ...insecureTls,
    } as any);

    ws.addEventListener("open", () => {
      backoffMs = 1000;
      onStatusChange?.("connected");
    });

    ws.addEventListener("message", (ev) => {
      let msg: DeviceEventMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (msg.type !== "update" && msg.type !== "add") return;
      if (msg.item.modelKey !== "sensor") return;

      const readings = rawSensorToReadings(msg.item.id, msg.item, Date.now());
      for (const reading of readings) onReading(reading);
    });

    ws.addEventListener("close", () => {
      onStatusChange?.("disconnected");
      if (closed) return;
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    });

    ws.addEventListener("error", () => {
      ws?.close();
    });
  }

  connect();

  return {
    close() {
      closed = true;
      ws?.close();
    },
  };
}

// Triggers a configured Alarm Manager rule (SPEC.md section 7) — used only
// if a deployment prefers Protect-side notification delivery over the
// latch's own webhook.url; not on the default path (see API_NOTES.md).
export async function triggerAlarmWebhook(config: ProtectConfig, alarmTriggerId: string): Promise<void> {
  await protectFetch(config, `/v1/alarm-manager/webhook/${encodeURIComponent(alarmTriggerId)}`, {
    method: "POST",
  });
}
