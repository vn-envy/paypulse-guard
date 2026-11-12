import type { AgAiConversationItem, AgAiEvent, AgAiOutputItem, AgLlmAdapter, AgLlmRequest, AgLlmResponse } from "ag-studio";

/**
 * AG Studio LLM adapter: turns one Studio agent turn into an OpenAI-compatible chat call through
 * /api/analytics/ai, then replays the answer as AG-UI events. Non-streaming: the whole turn
 * arrives at once and is emitted as start/content/end events.
 */

let n = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(n++).toString(36)}`;

function textOf(content: any[] | undefined): string {
  return (content ?? [])
    .map((c) => (c.type === "text" ? c.text : c.type === "refusal" ? c.refusal : ""))
    .filter(Boolean)
    .join("\n");
}

function toChat(req: AgLlmRequest) {
  const messages: any[] = [];
  if (req.instructions) messages.push({ role: "system", content: req.instructions });
  for (const item of req.input as AgAiConversationItem[]) {
    const it = item as any;
    if (it.type === "message" && it.kind === "input") {
      messages.push({ role: it.role === "system" ? "system" : "user", content: textOf(it.content) || "(empty)" });
    } else if (it.type === "message") {
      messages.push({ role: "assistant", content: textOf(it.content) });
    } else if (it.type === "function_call") {
      const call = { id: it.callId, type: "function", function: { name: it.name, arguments: it.arguments || "{}" } };
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && !last.__closed) (last.tool_calls ??= []).push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (it.type === "function_call_output") {
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") last.__closed = true;
      messages.push({ role: "tool", tool_call_id: it.callId, content: it.output ?? "" });
    }
  }
  for (const m of messages) delete m.__closed;
  const tools = (req.tools ?? [])
    .filter((t) => t.kind !== "provided")
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const tc = req.toolChoice;
  const tool_choice = !tc ? undefined : typeof tc === "string" ? tc : { type: "function", function: { name: tc.name } };
  const response_format =
    req.responseFormat?.type === "json"
      ? { type: "json_schema", json_schema: { name: req.responseFormat.name, description: req.responseFormat.description, schema: req.responseFormat.schema, strict: false } }
      : undefined;
  return { messages, tools, tool_choice, response_format };
}

const NOTICE: Record<string, string> = {
  locked: "The assistant uses your LLM key, so it only answers after you unlock signing in the cockpit.",
  no_llm: "No LLM key is configured. Set LLM_API_KEY in .env.local to use the assistant.",
};

export function guardedLlmAdapter(endpoint = "/api/analytics/ai"): AgLlmAdapter {
  return {
    executeTurn(request, options) {
      // Start the call now, so `complete` settles even if nobody reads the stream.
      const turn = (async (): Promise<{ events: AgAiEvent[]; response: AgLlmResponse }> => {
        const events: AgAiEvent[] = [];
        const output: AgAiOutputItem[] = [];
        const say = (text: string) => {
          const messageId = uid("msg");
          events.push({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text }, { type: "TEXT_MESSAGE_END", messageId });
          output.push({ id: messageId, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] });
        };
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(toChat(request)),
            signal: options?.signal,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            if (NOTICE[data.error]) {
              say(NOTICE[data.error]);
              return { events, response: { id: uid("resp"), createdAt: Date.now(), output, status: "completed" } };
            }
            throw new Error(data.error ?? `Assistant request failed (${res.status}).`);
          }
          const msg = data.message ?? {};
          if (typeof msg.content === "string" && msg.content.trim()) say(msg.content);
          for (const tc of msg.tool_calls ?? []) {
            const callId = tc.id || uid("call");
            const args = tc.function?.arguments || "{}";
            events.push(
              { type: "TOOL_CALL_START", toolCallId: callId, toolCallName: tc.function?.name },
              { type: "TOOL_CALL_ARGS", toolCallId: callId, delta: args },
              { type: "TOOL_CALL_END", toolCallId: callId },
            );
            output.push({ id: uid("fc"), kind: "output", type: "function_call", callId, name: tc.function?.name, arguments: args, status: "completed" });
          }
          return { events, response: { id: data.id ?? uid("resp"), createdAt: Date.now(), output, status: "completed", model: data.model } };
        } catch (e: any) {
          const aborted = e?.name === "AbortError";
          return {
            events,
            response: { id: uid("resp"), createdAt: Date.now(), output, status: aborted ? "cancelled" : "failed", error: aborted ? undefined : { code: "llm_error", message: String(e?.message ?? e) } },
          };
        }
      })();
      return {
        stream: {
          async *[Symbol.asyncIterator]() {
            const { events } = await turn;
            for (const e of events) yield e;
          },
        },
        complete: turn.then((t) => t.response),
      };
    },
  };
}
