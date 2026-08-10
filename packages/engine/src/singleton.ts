import type {
  ConsoleStatus,
  EffectiveInterval,
  Latch,
  Metric,
  ProtectConsole,
  Reading,
  SensorStatus,
  WebhookDelivery,
} from "@unifi-sensor-latch/shared";
import { effectiveInterval } from "@unifi-sensor-latch/shared";
import { AuthStore } from "./auth";
import { ConfigStore } from "./config";
import {
  checkConnection,
  fetchRawSensors,
  rawSensorToReadings,
  rawSensorToSensor,
  subscribeDevices,
  type DeviceSubscription,
} from "./protect";
import { dispatchWebhook } from "./webhookDispatcher";
import { applyReading, initialState } from "./stateMachine";

// The latch engine singleton. Boots once in apps/web/server.ts before the
// HTTPS listener comes up — never instantiated inside a Route Handler.
// globalThis-guarded so Next.js dev-mode HMR re-running module-level code
// doesn't spawn a second instance (CLAUDE.md "engine must not depend on the
// UI being open").
export class LatchEngine {
  readonly config = new ConfigStore();
  readonly auth = new AuthStore();

  private subscriptions = new Map<string, DeviceSubscription>();
  // Supplementary re-discovery timer per console — see connectConsole's
  // comment for why this exists alongside the websocket subscription.
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  // In-memory only, per ConsoleStatus/SensorStatus's doc comment (shared
  // types) — this is "is it alive right now", not a persisted history.
  private consoleStatuses = new Map<string, ConsoleStatus>();
  private sensorStatuses = new Map<string, SensorStatus>();
  // Raw per-(sensorId, metric) reading timestamps, used only to compute
  // the rolling-average observedIntervalSeconds exposed on SensorStatus —
  // not exposed itself. Keyed by "${sensorId}:${metric}".
  private lastReadingAt = new Map<string, number>();

  async boot(): Promise<void> {
    if (this.auth.count() === 0) {
      console.log("[auth] no accounts exist yet — sign-up is open until the first account is created");
    }

    for (const console_ of this.config.listProtectConsoles()) {
      await this.connectConsole(console_);
    }

    console.log("[engine] booted");
  }

  // Connects to one Protect console: does an initial sensor discovery pass
  // (so newly-added sensors show up without waiting for a websocket delta
  // that mentions them) and opens the realtime subscription. Called both on
  // boot (for every already-configured console) and whenever a console is
  // added through the UI, so a new console goes live without a restart.
  //
  // Deliberately returns a Promise the caller can choose not to await
  // (POST /api/consoles doesn't) — each phase records a step (see
  // pushStep) so the UI can poll GET /api/consoles and show a live trace
  // ("sending test probe" → "console reachable (v7.1.87, 42ms)" →
  // "discovering sensors" → "found 3 sensors" → "opening realtime
  // subscription" → "connected") instead of the request just hanging on a
  // spinner until the whole sequence finishes.
  async connectConsole(consoleConfig: ProtectConsole): Promise<void> {
    this.disconnectConsole(consoleConfig.id);
    this.consoleStatuses.delete(consoleConfig.id); // fresh step trace per attempt
    this.setConsoleStatus(consoleConfig.id, { connectionState: "connecting" });

    this.pushStep(consoleConfig.id, "Sending test probe to console", true);
    try {
      const { applicationVersion, latencyMs } = await checkConnection(consoleConfig);
      this.setConsoleStatus(consoleConfig.id, { applicationVersion, latencyMs, error: null });
      this.pushStep(consoleConfig.id, `Console reachable — Protect v${applicationVersion} (${latencyMs}ms)`, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[engine] console "${consoleConfig.name}" unreachable, not subscribing:`, err);
      this.setConsoleStatus(consoleConfig.id, { connectionState: "error", error: message });
      this.pushStep(consoleConfig.id, `Console unreachable: ${message}`, false);
      return;
    }

    this.pushStep(consoleConfig.id, "Discovering sensors", true);
    try {
      await this.discoverSensors(consoleConfig);
      const count = this.consoleStatuses.get(consoleConfig.id)?.sensorCount ?? 0;
      this.pushStep(consoleConfig.id, `Found ${count} sensor${count === 1 ? "" : "s"}`, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setConsoleStatus(consoleConfig.id, { connectionState: "error", error: message });
      this.pushStep(consoleConfig.id, `Sensor discovery failed: ${message}`, false);
      return;
    }

    this.pushStep(consoleConfig.id, "Opening realtime subscription", true);
    const subscription = subscribeDevices(
      consoleConfig,
      (reading) => this.ingest(reading),
      (status) => {
        console.log(`[engine] console "${consoleConfig.name}" websocket ${status}`);
        this.setConsoleStatus(consoleConfig.id, { connectionState: status });
        this.pushStep(
          consoleConfig.id,
          status === "connected" ? "Realtime subscription connected" : "Realtime subscription disconnected",
          status === "connected"
        );
      }
    );
    this.subscriptions.set(consoleConfig.id, subscription);

    // Supplementary to the websocket, not a replacement for it: live
    // testing against a real console showed the websocket reliably
    // delivering *some* events (wireless signal strength, connectivity)
    // but essentially never a metric value change for these battery
    // sensors — API_NOTES.md's original "push is sufficient, no polling
    // needed" call doesn't hold up under longer observation. Re-running
    // discovery periodically re-fetches each sensor's current value via
    // GET /v1/sensors (the same call discoverSensors already makes once
    // at connect time) so values actually stay fresh even if the
    // websocket never pushes a delta for them. Cadence is the console's
    // own defaultIntervalSeconds — deliberately not faster, per CLAUDE.md
    // ("don't poll faster than the sensor's own reporting interval").
    const pollMs = consoleConfig.defaultIntervalSeconds * 1000;
    const timer = setInterval(() => {
      this.discoverSensors(consoleConfig).catch((err) => {
        console.error(`[engine] periodic re-discovery failed for console "${consoleConfig.name}":`, err);
      });
    }, pollMs);
    this.pollTimers.set(consoleConfig.id, timer);
  }

  disconnectConsole(consoleId: string): void {
    this.subscriptions.get(consoleId)?.close();
    this.subscriptions.delete(consoleId);
    clearInterval(this.pollTimers.get(consoleId));
    this.pollTimers.delete(consoleId);
  }

  // Discovery-driven sensor list (SPEC.md section 12) — never hand-typed.
  //
  // GET /v1/sensors returns each sensor's *current* readings, not just
  // metadata — ingest() those immediately rather than only upserting
  // name/metrics and waiting on a spontaneous websocket delta to first
  // populate SensorStatus. Battery sensors can go a long time between
  // unprompted reports (see API_NOTES.md), so without this, the Sensors
  // page and any rule watching that sensor would show "no data yet" for
  // however long it took the sensor to next report on its own — even
  // though the console already told us the value the moment we asked.
  async discoverSensors(consoleConfig: ProtectConsole): Promise<void> {
    const raw = await fetchRawSensors(consoleConfig);
    const now = Date.now();
    for (const r of raw) {
      const sensor = rawSensorToSensor(r);
      this.config.upsertSensor({ ...sensor, consoleId: consoleConfig.id });

      for (const reading of rawSensorToReadings(r.id, r, now)) {
        this.ingest(reading);
      }
    }
    const sensorCount = this.config.listSensors().filter((s) => s.consoleId === consoleConfig.id).length;
    this.setConsoleStatus(consoleConfig.id, { sensorCount });
  }

  private setConsoleStatus(consoleId: string, patch: Partial<Omit<ConsoleStatus, "consoleId">>): void {
    const current: ConsoleStatus = this.consoleStatuses.get(consoleId) ?? {
      consoleId,
      connectionState: "disconnected",
      applicationVersion: null,
      latencyMs: null,
      lastEventAt: null,
      sensorCount: 0,
      error: null,
      steps: [],
    };
    this.consoleStatuses.set(consoleId, { ...current, ...patch });
  }

  private static readonly MAX_STEPS = 12;

  private pushStep(consoleId: string, label: string, ok: boolean): void {
    const current = this.consoleStatuses.get(consoleId);
    const steps = [...(current?.steps ?? []), { label, at: Date.now(), ok }].slice(-LatchEngine.MAX_STEPS);
    this.setConsoleStatus(consoleId, { steps });
  }

  getConsoleStatus(consoleId: string): ConsoleStatus | null {
    return this.consoleStatuses.get(consoleId) ?? null;
  }

  listConsoleStatuses(): ConsoleStatus[] {
    return [...this.consoleStatuses.values()];
  }

  getSensorStatus(sensorId: string): SensorStatus | null {
    return this.sensorStatuses.get(sensorId) ?? null;
  }

  listSensorStatuses(): SensorStatus[] {
    return [...this.sensorStatuses.values()];
  }

  // Resolves observed → console default for a given (sensorId, metric) —
  // the one place Rule duration validation (POST/PATCH /api/latches) and
  // the Rules page's duration-preset greying both go for "what interval
  // should this duration be checked against." Returns null only if the
  // sensor or its owning console can't be found.
  getEffectiveInterval(sensorId: string, metric: Metric): EffectiveInterval | null {
    const sensor = this.config.listSensors().find((s) => s.id === sensorId);
    if (!sensor) return null;
    const console_ = this.config.getProtectConsole(sensor.consoleId);
    if (!console_) return null;

    const observed = this.sensorStatuses.get(sensorId)?.observedIntervalSeconds[metric];
    return effectiveInterval(observed, console_.defaultIntervalSeconds);
  }

  // Ingest entrypoint — called for every reading, whether from a live
  // websocket push or (in tests) directly. Updates sensor/console status
  // (see above) for *every* reading, regardless of whether a latch exists
  // for it — the dashboard should show a sensor is alive even before
  // anyone's configured a rule against it. Then applies the reading to
  // every enabled latch watching that (sensorId, metric) pair and
  // dispatches the configured webhook on a fired/resolved transition.
  ingest(reading: Reading): void {
    const sensor = this.config.listSensors().find((s) => s.id === reading.sensorId);

    const currentSensorStatus = this.sensorStatuses.get(reading.sensorId);
    const historyKey = `${reading.sensorId}:${reading.metric}`;
    const previousAt = this.lastReadingAt.get(historyKey);
    this.lastReadingAt.set(historyKey, reading.timestamp);

    let observedIntervalSeconds = currentSensorStatus?.observedIntervalSeconds ?? {};
    if (previousAt != null) {
      const gapSeconds = (reading.timestamp - previousAt) / 1000;
      // Exponential moving average (alpha=0.3) rather than a plain mean —
      // adapts to a real change in reporting cadence without one-shot
      // network jitter swinging the estimate wildly.
      const priorEstimate = observedIntervalSeconds[reading.metric];
      const nextEstimate = priorEstimate == null ? gapSeconds : priorEstimate * 0.7 + gapSeconds * 0.3;
      observedIntervalSeconds = { ...observedIntervalSeconds, [reading.metric]: Math.round(nextEstimate) };
    }

    this.sensorStatuses.set(reading.sensorId, {
      sensorId: reading.sensorId,
      lastSeenAt: reading.timestamp,
      values: { ...currentSensorStatus?.values, [reading.metric]: reading.value },
      observedIntervalSeconds,
    });
    if (sensor) {
      this.setConsoleStatus(sensor.consoleId, { lastEventAt: reading.timestamp });
    }

    const latches = this.config.listLatches().filter((l) => l.sensorId === reading.sensorId && l.enabled);

    for (const latch of latches) {
      if (latch.metric !== reading.metric) continue;

      const current = this.config.getLatchState(latch.id) ?? initialState(latch.id, reading.timestamp);
      const { next, transition } = applyReading(latch, current, reading);
      this.config.saveLatchState(next);

      const sensorName = sensor?.name ?? reading.sensorId;

      if (transition.type === "fired") {
        void this.dispatchAndRecord(latch, latch.webhook, "fired", sensorName, reading.value);
      } else if (transition.type === "resolved" && latch.resolvedWebhook) {
        void this.dispatchAndRecord(latch, latch.resolvedWebhook, "resolved", sensorName, reading.value);
      }
    }
  }

  // Shared by real fire/resolve transitions and the Rules page's manual
  // Test button (sendTestWebhook) — dispatches, then always records the
  // outcome (success or failure) to webhook_deliveries so "last used" and
  // the response inspector have something to show regardless of whether
  // the send actually succeeded.
  private async dispatchAndRecord(
    latch: Latch,
    target: Latch["webhook"],
    kind: WebhookDelivery["kind"],
    sensorName: string,
    value: number
  ): Promise<void> {
    const result = await dispatchWebhook(target, { latch, sensorName, value });
    this.config.recordWebhookDelivery({
      id: crypto.randomUUID(),
      latchId: latch.id,
      kind,
      url: target.url,
      method: target.method,
      ok: result.ok,
      status: result.status ?? null,
      error: result.error ?? null,
      responseBodySnippet: result.responseBodySnippet ?? null,
      attempts: result.attempts,
      dispatchedAt: Date.now(),
    });
  }

  // Manually triggers the "fired" webhook for a rule (Rules page's Test
  // button) — same dispatch/record path as a real fire, just recorded as
  // kind "test" so it's never confused with an actual alarm. Uses the
  // sensor's current value if we have one (falls back to 0) purely for
  // template substitution ({{value}}) — no state-machine transition
  // happens, so this can never accidentally arm/fire/clear a rule.
  async sendTestWebhook(latchId: string): Promise<void> {
    const latch = this.config.listLatches().find((l) => l.id === latchId);
    if (!latch) throw new Error(`no such rule: ${latchId}`);

    const sensor = this.config.listSensors().find((s) => s.id === latch.sensorId);
    const sensorName = sensor?.name ?? latch.sensorId;
    const value = this.sensorStatuses.get(latch.sensorId)?.values[latch.metric] ?? 0;

    await this.dispatchAndRecord(latch, latch.webhook, "test", sensorName, value);
  }

  listWebhookDeliveries(latchId: string): WebhookDelivery[] {
    return this.config.listWebhookDeliveries(latchId);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __latchEngine: LatchEngine | undefined;
}

export function getEngine(): LatchEngine {
  if (!globalThis.__latchEngine) {
    globalThis.__latchEngine = new LatchEngine();
  }
  return globalThis.__latchEngine;
}
