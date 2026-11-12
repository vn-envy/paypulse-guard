import { NextResponse } from "next/server";
import { POLICY } from "@/lib/guard";
import { record } from "@/lib/ledger";
import { agentKey, rotateAgentKey } from "@/lib/mcp";
import { operator } from "@/lib/session";
import { persist } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Change what the external agent key may propose, or rotate it. Operator only. */
export async function POST(req: Request) {
  if (!(await operator()).ok) return NextResponse.json({ ok: false, reason: "Signing is locked." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (body.rotate) {
    const ak = rotateAgentKey();
    if (!ak) return NextResponse.json({ ok: false, reason: "The key is pinned by GUARD_AGENT_KEY." }, { status: 409 });
    record({ actor: "operator", event: "agent_key_rotated", target: "MCP", detail: "Issued a new agent key. The old one stops working now.", outcome: "info" });
    return NextResponse.json({ ok: true });
  }
  if (Array.isArray(body.scope)) {
    const ak = agentKey();
    ak.scope = POLICY.allowedActions.filter((a) => body.scope.includes(a));
    record({ actor: "operator", event: "agent_scope_changed", target: "MCP", detail: `External agents may now propose: ${ak.scope.join(", ") || "nothing (read only)"}.`, outcome: "info" });
    persist();
    return NextResponse.json({ ok: true, scope: ak.scope });
  }
  return NextResponse.json({ ok: false, reason: "Nothing to change." }, { status: 400 });
}
