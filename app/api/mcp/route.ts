import { endMcpSession, handleMcpPost } from "@/lib/mcp";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  return handleMcpPost(req);
}

/** This server answers each request directly and does not keep a stream open. */
export async function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } });
}

export async function DELETE(req: Request) {
  return endMcpSession(req);
}
