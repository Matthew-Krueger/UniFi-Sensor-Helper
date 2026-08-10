import type { ProtectConsole, Reading } from "@unifi-sensor-latch/shared";
import { AuthStore } from "./auth";
import { ConfigStore } from "./config";
import { checkConnection, fetchRawSensors, rawSensorToSensor, subscribeDevices, type DeviceSubscription } from "./protect";
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

  async boot(): Promise<void> {
    await this.auth.seedFromEnvIfEmpty();

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
  async connectConsole(consoleConfig: ProtectConsole): Promise<void> {
    this.disconnectConsole(consoleConfig.id);

    try {
      await checkConnection(consoleConfig);
    } catch (err) {
      console.error(`[engine] console "${consoleConfig.name}" unreachable, not subscribing:`, err);
      return;
    }

    await this.discoverSensors(consoleConfig);

    const subscription = subscribeDevices(
      consoleConfig,
      (reading) => this.ingest(reading),
      (status) => console.log(`[engine] console "${consoleConfig.name}" websocket ${status}`)
    );
    this.subscriptions.set(consoleConfig.id, subscription);
  }

  disconnectConsole(consoleId: string): void {
    this.subscriptions.get(consoleId)?.close();
    this.subscriptions.delete(consoleId);
  }

  // Discovery-driven sensor list (SPEC.md section 12) — never hand-typed.
  async discoverSensors(consoleConfig: ProtectConsole): Promise<void> {
    const raw = await fetchRawSensors(consoleConfig);
    for (const r of raw) {
      const sensor = rawSensorToSensor(r);
      this.config.upsertSensor({ ...sensor, consoleId: consoleConfig.id });
    }
  }

  // Ingest entrypoint — called for every reading, whether from a live
  // websocket push or (in tests) directly. Applies the reading to every
  // enabled latch watching that (sensorId, metric) pair and dispatches the
  // configured webhook on a fired/resolved transition.
  ingest(reading: Reading): void {
    const latches = this.config.listLatches().filter((l) => l.sensorId === reading.sensorId && l.enabled);

    for (const latch of latches) {
      if (latch.metric !== reading.metric) continue;

      const current = this.config.getLatchState(latch.id) ?? initialState(latch.id, reading.timestamp);
      const { next, transition } = applyReading(latch, current, reading);
      this.config.saveLatchState(next);

      const sensor = this.config.listSensors().find((s) => s.id === reading.sensorId);
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
