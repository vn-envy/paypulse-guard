import { NextResponse } from "next/server";
import { POLICY, activeStanding, signStanding } from "@/lib/guard";
import { record } from "@/lib/ledger";
import { book } from "@/lib/receivables";
import { operator } from "@/lib/session";
import { persist, store } from "@/lib/store";

export const dynamic = "force-dynamic";

const clamp = (n: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Number(n) : lo));

/** Sign a standing mandate. Only a person in an unlocked operator session can do this; no agent tool reaches it. */
export async function POST(req: Request) {
  if (!(await operator()).ok) {
    record({ actor: "guard", event: "denied_no_operator", target: "autopilot", detail: "Someone tried to sign a standing mandate without the operator session.", outcome: "denied" });
    return NextResponse.json({ ok: false, reason: "Signing is locked. Unlock it with the operator PIN." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const reminders = !!body.reminders;
  const maxDiscountPct = Math.round(clamp(body.maxDiscountPct, 0, POLICY.maxDiscountPct) * 10) / 10;
  const budget = Math.round(clamp(body.budget, 0, POLICY.dailyConcessionBudget));
  const days = Math.round(clamp(body.days, 1, 30));
  if (!reminders && !(maxDiscountPct > 0 && budget > 0)) {
    return NextResponse.json({ ok: false, reason: "Choose reminders, settlements, or both." }, { status: 400 });
  }
  const currency = (await book()).receivables[0]?.currency ?? "USD";
  const sm = signStanding({ reminders, maxDiscountPct, budget, days, currency });
  const s = store();
  const before = activeStanding();
  if (before) before.revokedAt = new Date().toISOString();
  s.standing = sm;
  const covers = [reminders ? "reminders" : null, maxDiscountPct > 0 && budget > 0 ? `settlements up to ${maxDiscountPct}% within ${currency} ${budget}` : null].filter(Boolean).join(" and ");
  record({ actor: "operator", event: "autopilot_signed", target: sm.id, detail: `Standing mandate for ${days} day${days === 1 ? "" : "s"}: ${covers}. Disputes and anything outside it still need a signature.`, outcome: "ok" });
  persist();
  return NextResponse.json({ ok: true, standing: { ...sm, sig: undefined } });
}

export async function DELETE() {
  if (!(await operator()).ok) return NextResponse.json({ ok: false, reason: "Signing is locked." }, { status: 401 });
  const sm = activeStanding();
  if (!sm) return NextResponse.json({ ok: false, reason: "Autopilot is already off." }, { status: 409 });
  sm.revokedAt = new Date().toISOString();
  record({ actor: "operator", event: "autopilot_revoked", target: sm.id, detail: `Revoked after ${sm.executed} action${sm.executed === 1 ? "" : "s"}, ${sm.currency} ${sm.spent.toFixed(2)} given up.`, outcome: "info" });
  persist();
  return NextResponse.json({ ok: true });
}
