import type {
  ConsoleStatus,
  Latch,
  ProtectConsole,
  Reading,
  SensorStatus,
  WebhookDelivery,
} from "@unifi-sensor-latch/shared";
import { AuthStore } from "./auth";
import { ConfigStore } from "./config";
import {
  checkConnection,
  fetchRawSensors,
  rawSensorBattery,
  rawSensorToReadings,
  rawSensorToSensor,
  subscribeDevices,
  type DeviceSubscription,
} from "./protect";
import { dispatchWebhook } from "./webhookDispatcher";
import { resolveWebhookTarget } from "./resolveWebhookTarget";
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
  // Safety-net re-discovery timer per console — see connectConsole's
  // comment for why this exists alongside the websocket subscription and
  // scheduleActivePull below. Deliberately slow: the active pull is the
  // primary freshness mechanism now, this only covers the websocket going
  // quiet without an explicit disconnect event.
  private safetyPollTimers = new Map<string, ReturnType<typeof setInterval>>();
  // Debounced GET /v1/sensors pull per console, (re)scheduled on every
  // sensor touch — see scheduleActivePull.
  private activePullTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly ACTIVE_PULL_DEBOUNCE_MS = 3000;
  // Safety poll cadence is a generous multiple of the console's own
  // default interval, with a floor — CLAUDE.md: don't poll faster than the
  // sensor's own reporting interval "just in case". This is deliberately
  // much slower than that floor since it's a fallback, not the primary
  // sync path.
  private static readonly SAFETY_POLL_MULTIPLIER = 4;
  private static readonly SAFETY_POLL_FLOOR_SECONDS = 900; // 15 minutes
  // In-memory only, per ConsoleStatus/SensorStatus's doc comment (shared
  // types) — this is "is it alive right now", not a persisted history.
  private consoleStatuses = new Map<string, ConsoleStatus>();
  private sensorStatuses = new Map<string, SensorStatus>();
  // Raw per-sensor checkin timestamps (see recordSensorCheckin), used only
  // to compute the rolling-average observedCheckinIntervalSeconds exposed
  // on SensorStatus — not exposed itself.
  private lastCheckinAt = new Map<string, number>();
  // Gap-sample count per sensor since boot — observedCheckinIntervalSeconds
  // stays null until this reaches MIN_CHECKIN_SAMPLES, so a sensor that
  // just started reporting doesn't get a noisy 1-2 sample interval
  // published (which could trigger a premature "delayed"/"overdue" badge
  // before we actually know its real cadence).
  private checkinSampleCounts = new Map<string, number>();
  private static readonly MIN_CHECKIN_SAMPLES = 3;
  // Internal EMA accumulator, kept separate from the published
  // observedCheckinIntervalSeconds field — the published field is null
  // (and must stay null) below MIN_CHECKIN_SAMPLES, but the average still
  // needs to keep accumulating underneath that gate rather than resetting
  // every round just because it isn't published yet.
  private checkinEstimateSeconds = new Map<string, number>();

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
      (sensorId, timestamp) => {
        this.recordSensorCheckin(sensorId, timestamp);
        this.scheduleActivePull(consoleConfig, sensorId);
      },
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

    // Safety net only — see scheduleActivePull for the primary freshness
    // path. Live testing against a real console showed the websocket
    // reliably delivering *some* events (wireless signal strength,
    // connectivity, and — now that we listen for it — the touch itself)
    // even when it rarely carries a metric value change directly, so a
    // debounced pull on every touch is what actually keeps values fresh;
    // this interval only covers the case where the websocket goes quiet
    // without an explicit disconnect event.
    const safetyPollMs =
      Math.max(consoleConfig.defaultIntervalSeconds * LatchEngine.SAFETY_POLL_MULTIPLIER, LatchEngine.SAFETY_POLL_FLOOR_SECONDS) *
      1000;
    const timer = setInterval(() => {
      this.discoverSensors(consoleConfig).catch((err) => {
        console.error(`[engine] safety-net re-discovery failed for console "${consoleConfig.name}":`, err);
      });
    }, safetyPollMs);
    this.safetyPollTimers.set(consoleConfig.id, timer);
  }

  // (Re)schedules a debounced GET /v1/sensors pull for this console —
  // called on every sensor touch (see connectConsole's onSensorTouch
  // wiring), accumulating which sensor(s) actually touched into
  // pendingTouchedSensorIds. Coalesces a burst of near-simultaneous
  // touches (e.g. three sensors on the same console reporting within a
  // couple seconds of each other) into a single pull instead of one per
  // touch: GET /v1/sensors already returns every sensor on the console in
  // one call, so there's no benefit to firing it more than once per
  // burst — but the pull only *applies* (ingests) a reading for the
  // sensor(s) that actually touched, per discoverSensors' onlySensorIds.
  // If sensor A touches and B/C ride along in the same bulk response
  // without having touched themselves, their entry in that response is
  // just Protect's last-known cache, not confirmation of anything new —
  // treating it as a fresh reading would be exactly the kind of "we
  // updated it, but nothing actually told us it changed" false freshness
  // recordSensorCheckin/lastSeenAt were already built to avoid.
  private pendingTouchedSensorIds = new Map<string, Set<string>>();

  private scheduleActivePull(consoleConfig: ProtectConsole, sensorId: string): void {
    const pending = this.pendingTouchedSensorIds.get(consoleConfig.id) ?? new Set<string>();
    pending.add(sensorId);
    this.pendingTouchedSensorIds.set(consoleConfig.id, pending);

    const existing = this.activePullTimers.get(consoleConfig.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.activePullTimers.delete(consoleConfig.id);
      const touchedIds = this.pendingTouchedSensorIds.get(consoleConfig.id) ?? new Set<string>();
      this.pendingTouchedSensorIds.delete(consoleConfig.id);
      this.discoverSensors(consoleConfig, { onlySensorIds: touchedIds }).catch((err) => {
        console.error(`[engine] active pull failed for console "${consoleConfig.name}":`, err);
      });
    }, LatchEngine.ACTIVE_PULL_DEBOUNCE_MS);
    this.activePullTimers.set(consoleConfig.id, timer);
  }

  // A sensor "touch" is any add/update websocket message naming this
  // sensor, metric-bearing or not (see protect.ts's onSensorTouch) — the
  // real "Protect just heard from this device" signal, independent of our
  // own poll timing. observedCheckinIntervalSeconds is withheld until
  // MIN_CHECKIN_SAMPLES gaps have been observed (see the field's class
  // comment) so a sensor that just started reporting doesn't get flagged
  // "delayed" off a noisy 1-2 sample guess.
  private recordSensorCheckin(sensorId: string, timestamp: number): void {
    const previousAt = this.lastCheckinAt.get(sensorId);
    this.lastCheckinAt.set(sensorId, timestamp);

    const current = this.sensorStatuses.get(sensorId);
    let observedCheckinIntervalSeconds = current?.observedCheckinIntervalSeconds ?? null;

    if (previousAt != null) {
      const gapSeconds = (timestamp - previousAt) / 1000;
      const sampleCount = (this.checkinSampleCounts.get(sensorId) ?? 0) + 1;
      this.checkinSampleCounts.set(sensorId, sampleCount);

      // Exponential moving average (alpha=0.3) — adapts to a real change
      // in reporting cadence without one-shot network jitter swinging the
      // estimate wildly. Accumulated in checkinEstimateSeconds regardless
      // of the publish gate below, so it isn't reset back to a 1-sample
      // guess every round while still under MIN_CHECKIN_SAMPLES.
      const priorEstimate = this.checkinEstimateSeconds.get(sensorId);
      const nextEstimate = priorEstimate == null ? gapSeconds : priorEstimate * 0.7 + gapSeconds * 0.3;
      this.checkinEstimateSeconds.set(sensorId, nextEstimate);

      observedCheckinIntervalSeconds = sampleCount >= LatchEngine.MIN_CHECKIN_SAMPLES ? Math.round(nextEstimate) : null;
    }

    this.sensorStatuses.set(sensorId, {
      sensorId,
      lastSeenAt: current?.lastSeenAt ?? null,
      values: current?.values ?? {},
      observedCheckinIntervalSeconds,
      battery: current?.battery ?? null,
    });
  }

  disconnectConsole(consoleId: string): void {
    this.subscriptions.get(consoleId)?.close();
    this.subscriptions.delete(consoleId);
    clearInterval(this.safetyPollTimers.get(consoleId));
    this.safetyPollTimers.delete(consoleId);
    clearTimeout(this.activePullTimers.get(consoleId));
    this.activePullTimers.delete(consoleId);
    this.pendingTouchedSensorIds.delete(consoleId);
  }

  // Merges in the latest known battery reading — called for every sensor
  // in a GET /v1/sensors response regardless of onlySensorIds scoping
  // (see discoverSensors below), since this isn't treated as a "reading"
  // with a freshness claim, just the last known value, same as sensor
  // metadata (name, enabled metrics).
  private updateSensorBattery(sensorId: string, battery: { percentage: number | null; isLow: boolean } | null): void {
    const current = this.sensorStatuses.get(sensorId);
    this.sensorStatuses.set(sensorId, {
      sensorId,
      lastSeenAt: current?.lastSeenAt ?? null,
      values: current?.values ?? {},
      observedCheckinIntervalSeconds: current?.observedCheckinIntervalSeconds ?? null,
      battery,
    });
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
  //
  // options.onlySensorIds, when given, restricts *ingestion* (readings,
  // and everything that flows from a reading: SensorStatus.values/
  // lastSeenAt, latch state evaluation) to that set — sensor metadata
  // (name, enabled metrics) is still synced for every sensor in the
  // response regardless, since that's identity/capability information,
  // not a "did it just report" claim. Used by scheduleActivePull's
  // debounced pull, which only knows a specific sensor (or a few) touched
  // — every other sensor in the same bulk response is just Protect's
  // last-known cache riding along in the same call, not confirmation that
  // sensor itself has anything new. Omit (full discovery) at connect time
  // and from the slow safety-net poll, where there's no touch to scope to
  // and a full re-sync is the point.
  async discoverSensors(consoleConfig: ProtectConsole, options?: { onlySensorIds?: Set<string> }): Promise<void> {
    const raw = await fetchRawSensors(consoleConfig);
    const now = Date.now();
    for (const r of raw) {
      const sensor = rawSensorToSensor(r);
      this.config.upsertSensor({ ...sensor, consoleId: consoleConfig.id });
      this.updateSensorBattery(r.id, rawSensorBattery(r));

      if (options?.onlySensorIds && !options.onlySensorIds.has(r.id)) continue;

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

  // Ingest entrypoint — called for every reading, whether from a live
  // websocket push, a GET /v1/sensors pull, or (in tests) directly.
  // Updates sensor/console status (see above) for *every* reading,
  // regardless of whether a latch exists for it — the dashboard should
  // show a sensor is alive even before anyone's configured a rule against
  // it. Then applies the reading to every enabled latch watching that
  // (sensorId, metric) pair and dispatches the configured webhook on a
  // fired/resolved transition.
  //
  // Does NOT touch observedCheckinIntervalSeconds — a GET pull re-ingests
  // every sensor on the console regardless of which one actually changed,
  // so timing gaps between ingest() calls reflect our own pull cadence,
  // not the physical device's real check-in rate. That's tracked
  // separately, only from real websocket touches — see
  // recordSensorCheckin.
  //
  // lastSeenAt is deliberately NOT set to reading.timestamp either, for
  // the same reason: a bulk GET /v1/sensors pull returns every sensor's
  // *current cached* value regardless of which sensor's touch actually
  // triggered the pull, so blindly stamping "now" here would make an
  // untouched sensor look freshly-reported just because a different
  // sensor on the same console happened to check in. lastSeenAt instead
  // mirrors lastCheckinAt (this sensor's own last real touch) once we
  // have one, falling back to the pull time only before any touch has
  // ever been observed for it (e.g. right after connect/discovery, when
  // "the last time we know anything" genuinely is "when we first asked").
  // The reading's *value* itself is still applied unconditionally below —
  // Protect's cache is the best known current value regardless of when it
  // last changed, only the "is this fresh" signal needs the distinction.
  ingest(reading: Reading): void {
    const sensor = this.config.listSensors().find((s) => s.id === reading.sensorId);
    const currentSensorStatus = this.sensorStatuses.get(reading.sensorId);

    this.sensorStatuses.set(reading.sensorId, {
      sensorId: reading.sensorId,
      lastSeenAt: this.lastCheckinAt.get(reading.sensorId) ?? reading.timestamp,
      values: { ...currentSensorStatus?.values, [reading.metric]: reading.value },
      observedCheckinIntervalSeconds: currentSensorStatus?.observedCheckinIntervalSeconds ?? null,
      battery: currentSensorStatus?.battery ?? null,
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
    // Resolution (looking up a "console" target's host/apiKey) can fail —
    // e.g. the console was deleted after this rule was configured to use
    // it — and that's just as much a real delivery failure as a network
    // error, so it's recorded the same way rather than thrown and lost.
    let resolved;
    try {
      resolved = resolveWebhookTarget(target, this.config);
    } catch (err) {
      this.config.recordWebhookDelivery({
        id: crypto.randomUUID(),
        latchId: latch.id,
        kind,
        url: target.kind === "custom" ? target.url : `console:${target.consoleId}/${target.webhookId}`,
        method: target.kind === "custom" ? target.method : "POST",
        ok: false,
        status: null,
        error: err instanceof Error ? err.message : String(err),
        responseBodySnippet: null,
        attempts: 0,
        dispatchedAt: Date.now(),
      });
      return;
    }

    const result = await dispatchWebhook(resolved, { latch, sensorName, value });
    this.config.recordWebhookDelivery({
      id: crypto.randomUUID(),
      latchId: latch.id,
      kind,
      url: resolved.url,
      method: resolved.method,
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
