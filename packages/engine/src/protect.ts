import type { Metric, Reading, Sensor } from "@unifi-sensor-latch/shared";
import { protectApiBase } from "@unifi-sensor-latch/shared";

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
  // Top-level `batteryStatus` is documented as deprecated in favor of this
  // — also the only battery field actually observed on the websocket's
  // "update" deltas (see API_NOTES.md's follow-up finding), so this is the
  // one path used both from GET /v1/sensors and (in principle) from a
  // websocket touch.
  wirelessConnectionState?: { batteryStatus?: { percentage: number | null; isLow: boolean } | null } | null;
}

export interface RawBattery {
  percentage: number | null;
  isLow: boolean;
}

export function rawSensorBattery(raw: RawSensor): RawBattery | null {
  const battery = raw.wirelessConnectionState?.batteryStatus;
  if (!battery) return null;
  return { percentage: battery.percentage, isLow: battery.isLow };
}

export interface ProtectConfig {
  host: string;
  apiKey: string;
  // See ProtectConsole.apiBaseUrlOverride (shared/src/types.ts) — most
  // callers never set this.
  apiBaseUrlOverride?: string | null;
}

function baseUrl(config: ProtectConfig): string {
  return protectApiBase(config.host, config.apiBaseUrlOverride);
}

// wss:// counterpart of baseUrl — subscribeDevices needs a websocket URL,
// not an HTTP one. An override is expected to be an http(s):// base (same
// as what protectApiBase returns for HTTP calls); swapped to ws(s):// here
// rather than asking the operator to enter two separate overrides.
function wsBaseUrl(config: ProtectConfig): string {
  return baseUrl(config).replace(/^http/i, "ws");
}

// Bun-specific fetch/WebSocket option to accept the console's self-signed
// cert — confirmed necessary live, see API_NOTES.md "Auth" section. This is
// about the outbound connection to the Protect console, unrelated to this
// app's own inbound HTTPS cert (CLAUDE.md process isolation). Exported so
// resolveWebhookTarget.ts can apply the same treatment to "console" kind
// webhook deliveries — same console, same self-signed cert.
export const insecureTls = { tls: { rejectUnauthorized: false } };

// Skipping cert validation is only correct for the default path (a direct
// LAN connection to the console's own self-signed cert, which is the norm
// for Protect, not an exception). apiBaseUrlOverride exists specifically
// for reaching a console through something else — e.g. UniFi's
// remote/cloud API base — which presents a real, publicly-trusted cert;
// silently skipping validation there would blind this app to a genuine
// MITM on a connection that's supposed to be verifiable. So: no override
// -> expect self-signed, skip validation. Override set -> validate for
// real. Exported so resolveWebhookTarget.ts applies the same rule to
// "console" kind webhook deliveries.
export function tlsOptionsFor(config: Pick<ProtectConfig, "apiBaseUrlOverride">): typeof insecureTls | {} {
  return config.apiBaseUrlOverride ? {} : insecureTls;
}

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
      ...tlsOptionsFor(config),
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
// which console this came from; this function is console-agnostic.
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

// id is `string | string[]` per the live OpenAPI spec's
// deviceBulkPartialWithReference schema — when multiple devices of the
// same modelKey change the same field(s) at once, Protect coalesces them
// into one message with an *array* of ids sharing one delta payload,
// rather than sending one message per device. Handling only the single-id
// case (as this did originally) means any bulk-coalesced sensor update
// silently produces a reading attributed to no real sensor (an array
// compared against string sensor ids never matches) — the exact shape of
// bug that looks like "the sensor stopped reporting" when it didn't.
interface DeviceEventMessage {
  type: "add" | "update" | "remove";
  item: Partial<RawSensor> & { id: string | string[]; modelKey: string };
}

// Pulled out of the websocket handler so the id-array-vs-single-string
// normalization is independently testable without a real socket.
export function readingsFromDeviceEventItem(item: DeviceEventMessage["item"], timestamp: number): Reading[] {
  const ids = Array.isArray(item.id) ? item.id : [item.id];
  return ids.flatMap((id) => rawSensorToReadings(id, item, timestamp));
}

export interface DeviceSubscription {
  close(): void;
}

// Subscribes to /v1/subscribe/devices (confirmed live, see API_NOTES.md) and
// calls onReading for every metric-bearing delta on a "sensor" device.
// Reconnects with exponential backoff on close/error rather than relying on
// an external scheduler — the engine is a persistent process, per CLAUDE.md
// "don't reach for cron ... those live inside the engine as timers".
// Verbose per-message tracing. On by default outside production (dev,
// test, a local `bun run dev`) so this is visible without remembering a
// flag; PROTECT_DEBUG=1 forces it on in production too, for diagnosing a
// live connectivity issue without redeploying. Every real websocket
// message used to be logged unconditionally regardless of environment on
// the theory that volume would stay low (minutes-scale report cadence);
// in practice bursts of "update"/no-metric-bearing-fields messages made
// the production server log mostly noise, hence gating it off there by
// default.
const DEBUG = process.env.PROTECT_DEBUG === "1" || process.env.NODE_ENV !== "production";

// Full raw wire payload per message — off even under DEBUG, since it's a
// lot more volume than the one-line summary and only useful for a
// specific live experiment (e.g. "change a value on the physical sensor
// right now and watch exactly what Protect actually sends"). Separate
// opt-in flag so the normal dev log stays at the one-line summary.
const LOG_RAW = process.env.PROTECT_LOG_RAW === "1";

export function subscribeDevices(
  config: ProtectConfig,
  onReading: (reading: Reading) => void,
  // Fired for every sensor id in an add/update message, metric-bearing or
  // not — this is the real "Protect just heard from this device" signal,
  // as opposed to onReading which only fires when the delta actually
  // carried a value change. singleton.ts uses this to measure each
  // sensor's true check-in cadence (untainted by our own poll timing) and
  // to trigger a debounced active pull — see its recordSensorCheckin/
  // scheduleActivePull.
  onSensorTouch: (sensorId: string, timestamp: number) => void,
  onStatusChange?: (status: "connected" | "disconnected") => void
): DeviceSubscription {
  let closed = false;
  let ws: WebSocket | null = null;
  let backoffMs = 1000;
  const maxBackoffMs = 30_000;

  function connect() {
    if (closed) return;
    const url = `${wsBaseUrl(config)}/v1/subscribe/devices`;
    ws = new WebSocket(url, {
      headers: { "X-API-KEY": config.apiKey },
      ...tlsOptionsFor(config),
    } as any);

    ws.addEventListener("open", () => {
      backoffMs = 1000;
      onStatusChange?.("connected");
    });

    ws.addEventListener("message", (ev) => {
      // Whole handler wrapped, not just JSON.parse — msg.item is only
      // guaranteed to exist per the schema for "add"/"update"; anything
      // else (a keepalive, a shape we haven't seen) threw an uncaught
      // TypeError here before, silently, with zero visibility into what
      // actually arrived.
      try {
        const msg: DeviceEventMessage = JSON.parse(ev.data as string);
        const ids = msg.item ? (Array.isArray(msg.item.id) ? msg.item.id : [msg.item.id]) : [];
        if (DEBUG) {
          console.log(`[protect] ws message: type=${msg.type} modelKey=${msg.item?.modelKey} ids=${ids.join(",")}`);
        }
        if (LOG_RAW) {
          console.log(`[protect] raw message:\n${JSON.stringify(msg, null, 2)}`);
        }

        if (msg.type !== "update" && msg.type !== "add") return;
        if (msg.item?.modelKey !== "sensor") return;

        const timestamp = Date.now();
        for (const id of ids) onSensorTouch(id, timestamp);

        const readings = readingsFromDeviceEventItem(msg.item, timestamp);
        if (readings.length === 0 && DEBUG) {
          console.log(`[protect] sensor delta had no metric-bearing fields (ids=${ids.join(",")})`);
        }
        for (const reading of readings) onReading(reading);
      } catch (err) {
        console.error("[protect] failed to process websocket message:", err);
        if (LOG_RAW) {
          console.error(`[protect] raw message that failed to process:\n${ev.data}`);
        }
      }
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
