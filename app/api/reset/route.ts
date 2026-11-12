import { NextResponse } from "next/server";
import { operator } from "@/lib/session";
import { invalidateBook } from "@/lib/receivables";
import { resetStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Clears proposals, ledger and (in emulator mode) restores the sample invoices. Never touches PayPal. */
export async function POST() {
  if (!(await operator()).ok) return NextResponse.json({ ok: false, reason: "Signing is locked." }, { status: 401 });
  resetStore();
  invalidateBook();
  return NextResponse.json({ ok: true });
}
