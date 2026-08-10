import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { consoleApiKeySchema, consoleHostSchema, consoleNameSchema, maskSecret } from "@unifi-sensor-latch/shared";
import type { ProtectConsole } from "@unifi-sensor-latch/shared";
import { requireRole } from "@/lib/auth";

// Protect console connections (host + API key) — user-editable in SQLite,
// not .env, since a site can have more than one console (see schema.ts).
// apiKey is secret-bearing: never echoed back in full, same rule as
// webhook URLs (CLAUDE.md obfuscation).
function redact(console_: ProtectConsole) {
  return { ...console_, apiKey: maskSecret(console_.apiKey) };
}

export async function GET() {
  const actor = await requireRole("user");
  if (actor instanceof NextResponse) return actor;
  const engine = getEngine();
  const consoles = engine.config.listProtectConsoles().map(redact);
  const statuses = engine.listConsoleStatuses();
  return NextResponse.json({ consoles, statuses });
}

export async function POST(req: NextRequest) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const body = await req.json();
  const name = consoleNameSchema.safeParse(body.name);
  if (!name.success) return NextResponse.json({ error: name.error.issues[0]?.message }, { status: 400 });
  const host = consoleHostSchema.safeParse(body.host);
  if (!host.success) return NextResponse.json({ error: host.error.issues[0]?.message }, { status: 400 });
  const apiKey = consoleApiKeySchema.safeParse(body.apiKey);
  if (!apiKey.success) return NextResponse.json({ error: apiKey.error.issues[0]?.message }, { status: 400 });

  const engine = getEngine();
  const id: string = typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
  const console_: ProtectConsole = { id, name: name.data, host: host.data, apiKey: apiKey.data, createdAt: Date.now() };

  engine.config.upsertProtectConsole(console_);

  // Not awaited: connectConsole can take several seconds (probe, discover,
  // subscribe, each with its own timeout — see protect.ts) and records a
  // step-by-step trace as it goes (ConsoleStatus.steps) rather than making
  // this request hang until the whole sequence finishes. The UI polls GET
  // /api/consoles to watch that trace land in near-real-time.
  engine.connectConsole(console_).catch((err) => {
    console.error("[api/consoles] connectConsole failed:", err);
  });

  return NextResponse.json({ console: redact(console_) }, { status: 201 });
}
