// Domain model — SPEC.md section 4. Exact Metric enum finalized during API
// discovery (SPEC.md section 8); this is a starting point, not final.
export type Metric = "lux" | "temperature" | "humidity" | "leak";

export interface Sensor {
  id: string; // Protect device id
  consoleId: string; // which ProtectConsole this sensor was discovered on
  name: string; // friendly name, editable in UI
  metrics: Metric[]; // discovered from the API
}

// A UniFi Protect console this deployment talks to. Stored in SQLite, not
// .env — unlike a single fixed operator credential, this is genuinely
// user-editable (a site can add/remove/repoint consoles through the UI,
// e.g. standing up a second deployment per SPEC.md section 12). apiKey is
// secret-bearing: mask it everywhere per CLAUDE.md's obfuscation rule,
// same as webhook URLs.
export interface ProtectConsole {
  id: string;
  name: string; // friendly label, e.g. "Main site NVR"
  host: string; // LAN IP or hostname
  apiKey: string;
  createdAt: number;
}

export type Direction = "above" | "below";

export interface WebhookTarget {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  bodyTemplate?: string; // {{sensorName}}, {{metric}}, {{value}}, {{threshold}}, {{durationMinutes}}
}

export interface Latch {
  id: string;
  sensorId: string;
  metric: Metric;
  direction: Direction;
  armThreshold: number;
  clearThreshold: number; // defaults to armThreshold if omitted at creation time
  durationSeconds: number;
  webhook: WebhookTarget;
  resolvedWebhook?: WebhookTarget;
  enabled: boolean;
}

export type LatchState = "idle" | "armed" | "fired";

export interface LatchStateRecord {
  latchId: string;
  state: LatchState;
  armedAt: number | null;
  firedAt: number | null;
  updatedAt: number;
}

export interface Reading {
  sensorId: string;
  metric: Metric;
  value: number;
  timestamp: number;
}

export interface User {
  id: string;
  username: string;
  createdAt: number;
}
