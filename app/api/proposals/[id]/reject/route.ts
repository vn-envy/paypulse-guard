import { NextResponse } from "next/server";
import { record } from "@/lib/ledger";
import { operator } from "@/lib/session";
import { persist, store } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await operator()).ok) return NextResponse.json({ ok: false, reason: "Signing is locked." }, { status: 401 });
  const p = store().proposals.find((x) => x.id === id);
  if (!p || p.status !== "pending") return NextResponse.json({ ok: false, reason: "Nothing to decline." }, { status: 409 });
  p.status = "rejected";
  record({ actor: "operator", event: "declined", target: p.targetLabel, detail: `${p.action.type} declined by operator.`, outcome: "info" });
  persist();
  return NextResponse.json({ ok: true });
}
