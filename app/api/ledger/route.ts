import { verifyChain } from "@/lib/ledger";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

/** The full audit ledger as a file, for an accountant or a dispute. Each entry's hash commits to the one before. */
export async function GET() {
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), chain: verifyChain(), entries: store().ledger }, null, 2);
  return new Response(body, {
    headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="paypulse-ledger-${new Date().toISOString().slice(0, 10)}.json"` },
  });
}
