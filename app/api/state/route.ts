import { NextResponse } from "next/server";
import { operator } from "@/lib/session";
import { snapshot } from "@/lib/state";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  return NextResponse.json(await snapshot(await operator(), fresh));
}
