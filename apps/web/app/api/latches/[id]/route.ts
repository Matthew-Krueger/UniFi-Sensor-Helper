import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import {
  intervalTooShortMessage,
  isDurationValid,
  latchNameSchema,
  validateCondition,
  validateWebhookTarget,
} from "@unifi-sensor-latch/shared";
import type { Latch, WebhookTarget } from "@unifi-sensor-latch/shared";
import { requireRole } from "@/lib/auth";
import { redactLatch } from "@/lib/latchRedaction";

// Empty string and null both mean "no name" — mirrors POST /api/latches's
// normalizeLatchName so the stored value only ever has one falsy shape.
function normalizeLatchName(raw: unknown): { ok: true; name: string | null } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true, name: null };
  const check = latchNameSchema.safeParse(raw);
  if (!check.success) return { ok: false, error: check.error.issues[0]?.message ?? "invalid name" };
  return { ok: true, name: check.data };
}

// The edit form never has the real bearerToken to resend (GET always
// masks it — see latchRedaction.ts), so a blank bearerToken on an edit
// means "keep the existing one," never "clear it." Mirrors how
// /api/consoles/[id] handles apiKey.
function preserveBearerToken(next: WebhookTarget, existing: WebhookTarget | undefined): WebhookTarget {
  if (next.kind !== "custom" || next.bearerToken) return next;
  if (existing?.kind === "custom" && existing.bearerToken) {
    return { ...next, bearerToken: existing.bearerToken };
  }
  return next;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const engine = getEngine();
  const existing = engine.config.listLatches().find((l) => l.id === id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const patch = (await req.json()) as Partial<Latch>;
  const updated: Latch = { ...existing, ...patch, id };

  if (patch.name !== undefined) {
    const nameCheck = normalizeLatchName(patch.name);
    if (!nameCheck.ok) {
      return NextResponse.json({ error: nameCheck.error }, { status: 400 });
    }
    updated.name = nameCheck.name;
  }

  if (patch.webhook !== undefined) updated.webhook = preserveBearerToken(patch.webhook, existing.webhook);
  if (patch.resolvedWebhook !== undefined) {
    updated.resolvedWebhook = preserveBearerToken(patch.resolvedWebhook, existing.resolvedWebhook);
  }

  if (patch.condition !== undefined) {
    const conditionCheck = validateCondition(updated.condition);
    if (!conditionCheck.valid) {
      return NextResponse.json({ error: conditionCheck.error }, { status: 400 });
    }
  }

  if (patch.webhook !== undefined) {
    const webhookCheck = validateWebhookTarget(updated.webhook);
    if (!webhookCheck.valid) {
      return NextResponse.json({ error: webhookCheck.error }, { status: 400 });
    }
  }
  if (patch.resolvedWebhook !== undefined && updated.resolvedWebhook) {
    const resolvedCheck = validateWebhookTarget(updated.resolvedWebhook);
    if (!resolvedCheck.valid) {
      return NextResponse.json({ error: resolvedCheck.error }, { status: 400 });
    }
  }

  if (patch.durationSeconds !== undefined && !isDurationValid(updated.durationSeconds)) {
    return NextResponse.json({ error: intervalTooShortMessage(updated.durationSeconds) }, { status: 400 });
  }

  engine.config.upsertLatch(updated);
  return NextResponse.json({ latch: redactLatch(updated, actor.role) });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  getEngine().config.deleteLatch(id);
  return NextResponse.json({ ok: true });
}
