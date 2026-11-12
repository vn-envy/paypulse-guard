import { NextResponse } from "next/server";
import { OPERATOR_COOKIE, checkPin, mintOperatorSession } from "@/lib/guard";
import { record } from "@/lib/ledger";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { pin } = await req.json().catch(() => ({ pin: "" }));
  if (!checkPin(pin)) {
    record({ actor: "guard", event: "unlock_failed", target: "signing key", detail: "Wrong operator PIN.", outcome: "denied" });
    return NextResponse.json({ ok: false, reason: "Wrong PIN." }, { status: 401 });
  }
  const session = mintOperatorSession();
  record({ actor: "operator", event: "unlocked_signing", target: "signing key", detail: "Operator unlocked signing for 30 minutes.", outcome: "info" });
  const res = NextResponse.json({ ok: true, exp: session.exp });
  res.cookies.set(OPERATOR_COOKIE, session.value, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 1800 });
  return res;
}
