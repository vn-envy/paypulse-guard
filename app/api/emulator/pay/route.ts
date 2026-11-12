import { NextResponse } from "next/server";
import { emulatorPay } from "@/lib/emulator";
import { paypalMode } from "@/lib/paypal";
import { book } from "@/lib/receivables";

export const dynamic = "force-dynamic";

/** Emulator only. Against the real sandbox the buyer pays on PayPal's own invoice page. */
export async function POST(req: Request) {
  if (paypalMode() !== "emulator") return NextResponse.json({ ok: false, reason: "Only available in emulator mode." }, { status: 403 });
  const { invoiceId } = await req.json().catch(() => ({}));
  const ok = emulatorPay(String(invoiceId));
  await book(true);
  return NextResponse.json({ ok }, { status: ok ? 200 : 409 });
}
