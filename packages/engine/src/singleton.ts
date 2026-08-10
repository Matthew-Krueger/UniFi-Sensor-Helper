import type { ConsoleStatus, EffectiveInterval, Metric, ProtectConsole, Reading, SensorStatus } from "@unifi-sensor-latch/shared";
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
  }

  disconnectConsole(consoleId: string): void {
    this.subscriptions.get(consoleId)?.close();
    this.subscriptions.delete(consoleId);
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
      // expectedIntervalSeconds: null here is only the *insert* default
      // for a brand-new sensor row — upsertSensor deliberately never
      // overwrites it on conflict, so a previously-set override survives
      // repeated discovery runs.
      this.config.upsertSensor({ ...sensor, consoleId: consoleConfig.id, expectedIntervalSeconds: null });

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

  // Resolves observed → sensor override → console default for a given
  // (sensorId, metric) — the one place Rule duration validation (POST/
  // PATCH /api/latches) and the Rules page's duration-preset greying
  // both go for "what interval should this duration be checked against."
  // Returns null only if the sensor or its owning console can't be found.
  getEffectiveInterval(sensorId: string, metric: Metric): EffectiveInterval | null {
    const sensor = this.config.listSensors().find((s) => s.id === sensorId);
    if (!sensor) return null;
    const console_ = this.config.getProtectConsole(sensor.consoleId);
    if (!console_) return null;

    const observed = this.sensorStatuses.get(sensorId)?.observedIntervalSeconds[metric];
    return effectiveInterval(observed, sensor.expectedIntervalSeconds, console_.defaultIntervalSeconds);
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
        void dispatchWebhook(latch.webhook, { latch, sensorName, value: reading.value });
      } else if (transition.type === "resolved" && latch.resolvedWebhook) {
        void dispatchWebhook(latch.resolvedWebhook, { latch, sensorName, value: reading.value });
      }
    }
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
