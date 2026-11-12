#!/usr/bin/env node
// Bridges an MCP client that only speaks stdio (Claude Desktop) to PayPulse Guard's HTTP endpoint.
// No dependencies. Configure it with PPG_URL and PPG_AGENT_KEY; the app shows the exact config to paste.
import readline from "node:readline";

const URL_ = process.env.PPG_URL || "http://localhost:3000/api/mcp";
const KEY = process.env.PPG_AGENT_KEY || "";
let session = null;

const log = (msg) => process.stderr.write(`[paypulse-guard] ${msg}\n`);
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

async function forward(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log("ignored a line that is not JSON");
    return;
  }
  const isRequest = msg && typeof msg.method === "string" && msg.id !== undefined && msg.id !== null;
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${KEY}`,
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify(msg),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) session = sid;
    if (res.status === 202) return;
    const text = await res.text();
    if (!res.ok) {
      log(`server answered ${res.status}: ${text.slice(0, 200)}`);
      if (isRequest) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `PayPulse Guard answered ${res.status}. ${res.status === 401 ? "Check PPG_AGENT_KEY." : text.slice(0, 200)}` } });
      return;
    }
    const data = JSON.parse(text);
    for (const m of Array.isArray(data) ? data : [data]) send(m);
  } catch (e) {
    log(`cannot reach ${URL_}: ${e.message}`);
    if (isRequest) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `PayPulse Guard is not reachable at ${URL_}. Start it with npm run dev.` } });
  }
}

if (!KEY) log("PPG_AGENT_KEY is not set, so the server will refuse every request.");
log(`forwarding to ${URL_}`);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim()) forward(line);
});
