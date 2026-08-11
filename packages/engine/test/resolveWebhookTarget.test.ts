import { describe, expect, test } from "bun:test";
import type { WebhookTarget } from "@unifi-sensor-latch/shared";
import { ConfigStore } from "../src/config";
import { createTestDb } from "../src/db";
import { resolveWebhookTarget } from "../src/resolveWebhookTarget";

function freshStore(): ConfigStore {
  return new ConfigStore(createTestDb());
}

describe("resolveWebhookTarget", () => {
  test("custom kind passes the URL/method through and turns a bearerToken into an Authorization header", () => {
    const target: WebhookTarget = { kind: "custom", url: "https://example.invalid/hook", method: "POST", bearerToken: "secret123" };
    const resolved = resolveWebhookTarget(target, freshStore());

    expect(resolved.url).toBe("https://example.invalid/hook");
    expect(resolved.method).toBe("POST");
    expect(resolved.headers).toEqual({ Authorization: "Bearer secret123" });
  });

  test("custom kind with no bearerToken sends no Authorization header", () => {
    const target: WebhookTarget = { kind: "custom", url: "https://example.invalid/hook", method: "GET" };
    const resolved = resolveWebhookTarget(target, freshStore());

    expect(resolved.headers).toBeUndefined();
  });

  test("console kind builds the Alarm Manager webhook URL and authenticates with the console's API key", () => {
    const store = freshStore();
    store.upsertProtectConsole({
      id: "console-1",
      name: "Main site NVR",
      host: "192.168.1.1",
      apiKey: "console-api-key",
      apiBaseUrlOverride: null,
      defaultWebhookId: "default-hook",
      downAlertEnabled: false,
      downAlertDurationSeconds: null,
      downAlertWebhook: null,
      downAlertResolvedWebhook: null,
      createdAt: 0,
    });

    const target: WebhookTarget = { kind: "console", consoleId: "console-1", webhookId: "freezer-alert" };
    const resolved = resolveWebhookTarget(target, store);

    expect(resolved.url).toBe("https://192.168.1.1/proxy/protect/integration/v1/alarm-manager/webhook/freezer-alert");
    expect(resolved.method).toBe("POST");
    expect(resolved.headers).toEqual({ "X-API-Key": "console-api-key", Accept: "application/json" });
    expect(resolved.insecure).toBe(true); // self-signed cert, same as every other call to this console
  });

  test("console kind respects apiBaseUrlOverride when set", () => {
    const store = freshStore();
    store.upsertProtectConsole({
      id: "console-2",
      name: "Remote NVR",
      host: "192.168.1.1",
      apiKey: "console-api-key",
      apiBaseUrlOverride: "https://unifi.ui.com/proxy/consoles/abc123/protect/integration",
      defaultWebhookId: null,
      downAlertEnabled: false,
      downAlertDurationSeconds: null,
      downAlertWebhook: null,
      downAlertResolvedWebhook: null,
      createdAt: 0,
    });

    const target: WebhookTarget = { kind: "console", consoleId: "console-2", webhookId: "freezer-alert" };
    const resolved = resolveWebhookTarget(target, store);

    expect(resolved.url).toBe("https://unifi.ui.com/proxy/consoles/abc123/protect/integration/v1/alarm-manager/webhook/freezer-alert");
    // Unlike a direct-to-console connection (self-signed by default — see
    // the test above), an override implies a real cert, so it should get
    // real validation, not the self-signed bypass.
    expect(resolved.insecure).toBe(false);
  });

  test("console kind throws if the referenced console no longer exists", () => {
    const target: WebhookTarget = { kind: "console", consoleId: "missing-console", webhookId: "freezer-alert" };
    expect(() => resolveWebhookTarget(target, freshStore())).toThrow();
  });
});
