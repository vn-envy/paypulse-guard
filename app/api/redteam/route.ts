import { NextResponse } from "next/server";
import { runAttacks } from "@/lib/redteam";

export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json({ results: await runAttacks() });
}
