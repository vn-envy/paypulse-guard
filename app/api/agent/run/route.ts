import { runAgent, type AgentEvent } from "@/lib/agent";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Streams the agent's work as newline-delimited JSON so the UI can show each step as it happens. */
export async function POST() {
  const s = store();
  if (s.agentRunning) return Response.json({ error: "The agent is already running." }, { status: 409 });
  s.agentRunning = true;
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        } catch {
          /* client went away; keep working so proposals still land */
        }
      };
      try {
        await runAgent(emit);
      } catch (e: any) {
        emit({ kind: "warn", text: e.message ?? String(e) });
        emit({ kind: "done", summary: "The run stopped early." });
      } finally {
        s.agentRunning = false;
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
