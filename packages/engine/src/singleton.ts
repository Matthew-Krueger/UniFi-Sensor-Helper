import type { Reading } from "@unifi-sensor-latch/shared";
import { AuthStore } from "./auth";
import { ConfigStore } from "./config";
import { applyReading, initialState } from "./stateMachine";

// The latch engine singleton. Boots once in apps/web/server.ts before the
// HTTPS listener comes up — never instantiated inside a Route Handler.
// globalThis-guarded so Next.js dev-mode HMR re-running module-level code
// doesn't spawn a second instance (CLAUDE.md "engine must not depend on the
// UI being open").
export class LatchEngine {
  readonly config = new ConfigStore();
  readonly auth = new AuthStore();

  async boot(): Promise<void> {
    await this.auth.seedFromEnvIfEmpty();
    console.log("[engine] booted");
  }

  // Ingest entrypoint. TODO(section 8): wire this to real Protect readings
  // (websocket subscribe or poll) once API discovery lands. Webhook dispatch
  // on "fired"/"resolved" transitions is also TODO — stubbed as a console
  // log for now so the state machine's correctness can be exercised without
  // a live Protect console.
  ingest(reading: Reading): void {
    const latches = this.config.listLatches().filter((l) => l.sensorId === reading.sensorId && l.enabled);

    for (const latch of latches) {
      if (latch.metric !== reading.metric) continue;

      const current = this.config.getLatchState(latch.id) ?? initialState(latch.id, reading.timestamp);
      const { next, transition } = applyReading(latch, current, reading);
      this.config.saveLatchState(next);

      if (transition.type === "fired") {
        console.log(`[engine] TODO dispatch webhook: latch ${latch.id} fired`);
      } else if (transition.type === "resolved") {
        console.log(`[engine] TODO dispatch resolvedWebhook: latch ${latch.id} resolved`);
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
