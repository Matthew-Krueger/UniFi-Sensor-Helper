import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { maskSecret } from "@unifi-sensor-latch/shared";
import type { ProtectConsole } from "@unifi-sensor-latch/shared";
import { getSessionUserId } from "@/lib/session";

// Protect console connections (host + API key) — user-editable in SQLite,
// not .env, since a site can have more than one console (see schema.ts).
// apiKey is secret-bearing: never echoed back in full, same rule as
// webhook URLs (CLAUDE.md obfuscation).
function redact(console_: ProtectConsole) {
  return { ...console_, apiKey: maskSecret(console_.apiKey) };
}

export async function GET() {
  if (!(await getSessionUserId())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const consoles = getEngine().config.listProtectConsoles().map(redact);
  return NextResponse.json({ consoles });
}

export async function POST(req: NextRequest) {
  if (!(await getSessionUserId())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const { name, host, apiKey } = body;
  if (typeof name !== "string" || typeof host !== "string" || typeof apiKey !== "string" || !name || !host || !apiKey) {
    return NextResponse.json({ error: "name, host, and apiKey are required" }, { status: 400 });
  }

  const engine = getEngine();
  const id: string = typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
  const console_: ProtectConsole = { id, name, host, apiKey, createdAt: Date.now() };

  engine.config.upsertProtectConsole(console_);

  try {
    await engine.connectConsole(console_);
  } catch (err) {
    // Saved even if the console isn't reachable right now — connectConsole
    // itself logs and simply doesn't subscribe; the UI can retry later.
    console.error("[api/consoles] connectConsole failed:", err);
  }

  return NextResponse.json({ console: redact(console_) }, { status: 201 });
}
