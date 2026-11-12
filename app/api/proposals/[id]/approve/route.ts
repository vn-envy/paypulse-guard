import { NextResponse } from "next/server";
import { execute, mintApproval } from "@/lib/guard";
import { record } from "@/lib/ledger";
import { operator } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Human approval. Requires the operator session; an agent calling this without it gets 401. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = store().proposals.find((x) => x.id === id);
  const op = await operator();
  if (!op.ok) {
    record({ actor: "guard", event: "denied_no_operator", target: p?.targetLabel ?? id, detail: "Approve was called without an unlocked operator session.", outcome: "denied", amount: p?.verdict.exposure || undefined, currency: p?.verdict.currency });
    return NextResponse.json({ ok: false, code: "no_operator", reason: "Signing is locked. Unlock it with the operator PIN." }, { status: 401 });
  }
  if (!p) return NextResponse.json({ ok: false, code: "unknown_proposal", reason: "No such proposal." }, { status: 404 });
  const approval = mintApproval(p.id, p.hash, "operator");
  const result = await execute({ proposalId: p.id, action: p.action, approval });
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "paypal_error" ? 502 : 409 });
}
