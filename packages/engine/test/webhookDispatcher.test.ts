import { describe, expect, test } from "bun:test";
import type { Latch, WebhookTarget } from "@unifi-sensor-latch/shared";
import { dispatchWebhook } from "../src/webhookDispatcher";

const latch: Latch = {
  id: "freezer-temp",
  sensorId: "sensor-1",
  metric: "temperature",
  condition: { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } },
  durationSeconds: 600,
  webhook: { url: "https://example.invalid/webhook/fired?token=supersecret123", method: "POST" },
  enabled: true,
};

describe("dispatchWebhook", () => {
  test("succeeds on first attempt, no retry", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls++;
      return new Response(null, { status: 204 });
    };

    const result = await dispatchWebhook(latch.webhook, { latch, sensorName: "Walk-in Freezer", value: 60 }, fakeFetch as any);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  test("retries on failure and eventually succeeds", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls++;
      if (calls < 2) return new Response(null, { status: 500 });
      return new Response(null, { status: 200 });
    };

    const result = await dispatchWebhook(
      latch.webhook,
      { latch, sensorName: "Walk-in Freezer", value: 60 },
      fakeFetch as any,
      1 // near-zero retry delay for test speed
    );

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  test("gives up after max attempts and reports failure", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls++;
      return new Response(null, { status: 500 });
    };

    const result = await dispatchWebhook(
      latch.webhook,
      { latch, sensorName: "Walk-in Freezer", value: 60 },
      fakeFetch as any,
      1
    );

    expect(result.ok).toBe(false);
    expect(calls).toBe(3);
  });

  test("substitutes template variables into the POST body", async () => {
    let capturedBody: string | undefined;
    const fakeFetch = async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return new Response(null, { status: 200 });
    };

    const target: WebhookTarget = {
      url: "https://example.invalid/webhook",
      method: "POST",
      bodyTemplate: "{{sensorName}} {{metric}} is {{value}} (threshold {{threshold}}, armed {{durationMinutes}}m)",
    };

    await dispatchWebhook(target, { latch, sensorName: "Walk-in Freezer", value: 60 }, fakeFetch as any);

    expect(capturedBody).toBe("Walk-in Freezer temperature is 60 (threshold 55, armed 10m)");
  });

  test("never logs the full webhook URL, even one embedding a token", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const fakeFetch = async () => new Response(null, { status: 200 });
      await dispatchWebhook(latch.webhook, { latch, sensorName: "Walk-in Freezer", value: 60 }, fakeFetch as any);
    } finally {
      console.log = originalLog;
    }

    const joined = logs.join("\n");
    expect(joined).not.toContain("supersecret123");
  });
});
