import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import {
  intervalTooShortMessage,
  isDurationValid,
  latchNameSchema,
  validateCondition,
  validateWebhookTarget,
} from "@unifi-sensor-latch/shared";
import type { Latch } from "@unifi-sensor-latch/shared";
import { requireRole } from "@/lib/auth";
import { redactLatch } from "@/lib/latchRedaction";

// Empty string and null both mean "no name" — normalized to null so the
// stored value and the UI's "does this rule have a name" check
// (rules-client.tsx) only ever have to handle one falsy case, not two.
function normalizeLatchName(raw: unknown): { ok: true; name: string | null } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true, name: null };
  const check = latchNameSchema.safeParse(raw);
  if (!check.success) return { ok: false, error: check.error.issues[0]?.message ?? "invalid name" };
  return { ok: true, name: check.data };
}

export async function GET() {
  const actor = await requireRole("user");
  if (actor instanceof NextResponse) return actor;
  const latches = getEngine().config.listLatches().map((l) => redactLatch(l, actor.role));
  return NextResponse.json({ latches });
}

export async function POST(req: NextRequest) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const latch = (await req.json()) as Latch;

  const nameCheck = normalizeLatchName(latch.name);
  if (!nameCheck.ok) {
    return NextResponse.json({ error: nameCheck.error }, { status: 400 });
  }
  latch.name = nameCheck.name;

  const conditionCheck = validateCondition(latch.condition);
  if (!conditionCheck.valid) {
    return NextResponse.json({ error: conditionCheck.error }, { status: 400 });
  }

  const webhookCheck = validateWebhookTarget(latch.webhook);
  if (!webhookCheck.valid) {
    return NextResponse.json({ error: webhookCheck.error }, { status: 400 });
  }
  if (latch.resolvedWebhook) {
    const resolvedCheck = validateWebhookTarget(latch.resolvedWebhook);
    if (!resolvedCheck.valid) {
      return NextResponse.json({ error: resolvedCheck.error }, { status: 400 });
    }
  }

  if (!isDurationValid(latch.durationSeconds)) {
    return NextResponse.json({ error: intervalTooShortMessage(latch.durationSeconds) }, { status: 400 });
  }

  const engine = getEngine();
  engine.config.upsertLatch(latch);
  return NextResponse.json({ latch: redactLatch(latch, actor.role) }, { status: 201 });
}
