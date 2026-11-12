import { NextResponse } from "next/server";
import { llmConfig, reasoningEffort, rememberEffortNone } from "@/lib/agent";
import { operator } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * One LLM turn for AG Studio's analytics assistant. The browser sends chat messages and the
 * Studio tool schemas; this forwards them with the server's LLM key. The analytics assistant only
 * ever gets Studio's own tools (build charts, filter, query the in-browser data). It has no route
 * to PayPal or to the guard. It spends your LLM key, so it needs the operator session.
 */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return NextResponse.json({ error: "Cross-origin requests are not accepted." }, { status: 403 });
  if (!(await operator()).ok) return NextResponse.json({ error: "locked" }, { status: 401 });
  const cfg = llmConfig();
  if (!cfg.enabled) return NextResponse.json({ error: "no_llm" }, { status: 501 });

  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.messages)) return NextResponse.json({ error: "Bad request." }, { status: 400 });

  let effort = reasoningEffort(cfg.model);
  const call = () =>
    fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: body.messages,
        ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools, tool_choice: body.tool_choice ?? "auto" } : {}),
        ...(body.response_format ? { response_format: body.response_format } : {}),
        ...(effort ? { reasoning_effort: effort } : {}),
      }),
      signal: AbortSignal.timeout(110_000),
    });
  let res = await call();
  let text = await res.text();
  if (res.status === 400 && !effort && /reasoning_effort/.test(text)) {
    effort = "none";
    rememberEffortNone(cfg.model);
    res = await call();
    text = await res.text();
  }
  if (!res.ok) return NextResponse.json({ error: `LLM ${res.status}: ${text.slice(0, 300)}` }, { status: 502 });
  const data = JSON.parse(text);
  return NextResponse.json({ id: data.id, model: data.model ?? cfg.model, message: data.choices?.[0]?.message ?? {} });
}
