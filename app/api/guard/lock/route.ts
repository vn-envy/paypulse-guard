import { NextResponse } from "next/server";
import { OPERATOR_COOKIE } from "@/lib/guard";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(OPERATOR_COOKIE);
  return res;
}
