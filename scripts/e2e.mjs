// End-to-end check of the guard against a running server in emulator mode.
//   terminal 1: npm run dev        (with no PAYPAL_* set)
//   terminal 2: npm run test:e2e
// It resets the app's local state first. It never talks to PayPal.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PIN = process.env.GUARD_OPERATOR_PIN ?? "2468";
let cookie = "";
let n = 0;
const pass = (msg) => console.log(`ok ${++n}  ${msg}`);

async function call(path, { method = "GET", body, auth = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(auth && cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && setCookie.includes("ppg_operator=")) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const state = async () => (await call("/api/state?fresh=1")).data;

// --- setup
let r = await call("/api/guard/unlock", { method: "POST", body: { pin: "0000" } });
assert.equal(r.status, 401);
pass("wrong PIN does not unlock signing");
r = await call("/api/guard/unlock", { method: "POST", body: { pin: PIN } });
assert.equal(r.status, 200);
await call("/api/reset", { method: "POST" });
let s = await state();
assert.equal(s.mode, "emulator", "this test must run in emulator mode (unset PAYPAL_CLIENT_ID)");
assert.equal(s.metrics.outstanding, 8150);
assert.equal(s.metrics.overdue, 6950);
pass("receivables load: 8,150 outstanding, 6,950 overdue");

// --- agent run
const run = await fetch(BASE + "/api/agent/run", { method: "POST" });
const events = (await run.text()).trim().split("\n").map((l) => JSON.parse(l));
assert.equal(events.at(-1).kind, "done");
s = await state();
const byType = (t) => s.proposals.find((p) => p.action.type === t && p.status === "pending");
const settle = byType("offer_settlement"), remind = byType("send_reminder"), concede = byType("accept_dispute_claim");
assert.ok(settle && remind && concede, "expected settlement, reminder and dispute proposals");
assert.equal(settle.verdict.exposure, 240);
assert.ok(!s.proposals.some((p) => p.action.disputeId === "PP-D-8830"), "the 640 dispute must not be proposed by the rules planner");
assert.ok(!s.proposals.some((p) => p.targetLabel === "INV-2044"), "an invoice that is not due must be left alone");
pass(`agent proposed ${s.proposals.length} actions and left the not-yet-due invoice alone (planner: ${events[0].planner})`);

// --- no operator, no execution
r = await call(`/api/proposals/${settle.id}/approve`, { method: "POST", auth: false });
assert.equal(r.status, 401);
assert.equal((await state()).proposals.find((p) => p.id === settle.id).status, "pending");
pass("approve without the operator session is refused (401) and nothing executes");

// --- signed execution
r = await call(`/api/proposals/${settle.id}/approve`, { method: "POST" });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.proposal.calls.length, 3);
s = await state();
const replacement = s.receivables.find((x) => x.collectible && x.due === 4560);
assert.ok(replacement, "replacement invoice at 4,560 should exist");
assert.equal(s.receivables.find((x) => x.number === "INV-2041").status, "CANCELLED");
pass("signed settlement: draft created, sent, original cancelled (3 PayPal calls, 4,800 -> 4,560)");

r = await call(`/api/proposals/${settle.id}/approve`, { method: "POST" });
assert.equal(r.status, 409);
assert.equal(r.data.code, "replay");
pass("signing the same proposal twice is refused as a replay");

r = await call(`/api/proposals/${remind.id}/approve`, { method: "POST" });
assert.equal(r.status, 200, JSON.stringify(r.data));
r = await call(`/api/proposals/${concede.id}/approve`, { method: "POST" });
assert.equal(r.status, 200, JSON.stringify(r.data));
pass("reminder and 28.00 dispute concession execute after signature");

// --- attacks
r = await call("/api/redteam", { method: "POST", auth: false });
const codes = r.data.results.map((a) => a.code);
assert.ok(r.data.results.every((a) => a.blocked), JSON.stringify(r.data.results));
assert.deepEqual(codes, ["no_signature", "payload_tampered", "blocked_by_mandate", "replay", "autopilot_tampered"]);
pass(`all five attacks blocked: ${codes.join(", ")}`);
s = await state();
assert.equal(s.receivables.filter((x) => x.collectible).length, 3, "attacks must not change PayPal state");
pass("attacks changed nothing on the PayPal side");

// --- payment closes the loop
r = await call("/api/emulator/pay", { method: "POST", body: { invoiceId: replacement.id } });
assert.equal(r.status, 200);
s = await state();
assert.equal(s.metrics.recovered, 4560);
assert.ok(s.ledger.some((e) => e.event === "invoice_paid"));
pass("client pays the settlement invoice: 4,560 counted as recovered");

// --- webhook and ledger integrity
r = await call("/api/paypal/webhooks", { method: "POST", body: { id: "WH-FAKE", event_type: "INVOICING.INVOICE.PAID" }, auth: false });
assert.equal(r.status, 400);
pass("unsigned webhook is refused");
s = await state();
assert.equal(s.chain.ok, true);
assert.ok(s.metrics.stopped > 0);
pass(`audit ledger hash chain intact across ${s.ledgerSize} entries`);


// ================= autopilot (standing mandate) =================
await call("/api/reset", { method: "POST" });
r = await call("/api/autopilot", { method: "POST", body: { reminders: true, maxDiscountPct: 3, budget: 150, days: 7 }, auth: false });
assert.equal(r.status, 401);
pass("signing a standing mandate without the operator session is refused");

r = await call("/api/autopilot", { method: "POST", body: { reminders: true, maxDiscountPct: 3, budget: 150, days: 7 } });
assert.equal(r.status, 200, JSON.stringify(r.data));
s = await state();
assert.equal(s.autopilot.on, true);
assert.equal(s.autopilot.budget, 150);

const run2 = await fetch(BASE + "/api/agent/run", { method: "POST" });
await run2.text();
s = await state();
const autoRem = s.proposals.find((p) => p.action.type === "send_reminder");
const waitSettle = s.proposals.find((p) => p.action.type === "offer_settlement");
const waitDispute = s.proposals.find((p) => p.action.type === "accept_dispute_claim");
assert.equal(autoRem.status, "executed", JSON.stringify(autoRem));
assert.ok(autoRem.approval.approver.startsWith("autopilot:"));
assert.equal(waitSettle.status, "pending");
assert.match(waitSettle.autopilot.note, /above autopilot's 3% limit/);
assert.equal(waitDispute.status, "pending");
assert.match(waitDispute.autopilot.note, /Disputes always wait/);
assert.ok(s.ledger.some((e) => e.event === "auto_signed"));
pass("autopilot sent the reminder on its own; the 5% settlement and the dispute wait for a signature");

r = await call("/api/redteam", { method: "POST", auth: false });
const forged = r.data.results.find((a) => a.id === "autopilot");
assert.equal(forged.blocked, true);
assert.equal(forged.code, "autopilot_tampered", JSON.stringify(forged));
s = await state();
assert.equal(s.autopilot.maxDiscountPct, 3, "the real standing mandate must be untouched");
assert.equal(s.proposals.find((p) => p.id === waitSettle.id).status, "pending", "the settlement must still be waiting");
pass("an agent that rewrites its standing mandate gets nothing: the forged terms fail the signature check");

// ================= MCP =================
const key = s.agents.key;
assert.ok(key && key.startsWith("ppg_"), "operator view should include the agent key");
let sid = null;
let rpcId = 0;
async function mcp(method, params, { auth = key, notify = false } = {}) {
  const res = await fetch(BASE + "/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(sid ? { "Mcp-Session-Id": sid } : {}),
    },
    body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const h = res.headers.get("mcp-session-id");
  if (h) sid = h;
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
const toolJson = (res) => JSON.parse(res.data.result.content[0].text);

r = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-agent", version: "1.0" } }, { auth: "ppg_wrong" });
assert.equal(r.status, 401);
pass("MCP refuses a request without a valid agent key");

r = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-agent", version: "1.0" } });
assert.equal(r.status, 200);
assert.equal(r.data.result.protocolVersion, "2025-06-18");
assert.ok(sid, "initialize should assign a session");
assert.equal((await mcp("notifications/initialized", {}, { notify: true })).status, 202);
r = await mcp("tools/list", {});
const names = r.data.result.tools.map((t) => t.name);
assert.deepEqual(names, ["list_receivables", "list_disputes", "get_mandate", "get_action_history", "propose_action", "get_proposal"]);
assert.ok(!names.some((n) => /execute|refund|approve|sign/.test(n)));
pass(`MCP handshake works and the agent gets ${names.length} tools, none of which can execute`);

r = await mcp("tools/call", { name: "list_receivables", arguments: {} });
const acme = toolJson(r).invoices.find((i) => i.number === "INV-2041");
const halden = toolJson(r).invoices.find((i) => i.number === "INV-2044");
r = await mcp("tools/call", { name: "propose_action", arguments: { type: "offer_settlement", target_id: acme.invoice_id, discount_pct: 20, note: "Pay this week for 20% off. Accounts", rationale: "Owner asked for 20%." } });
let out = toolJson(r);
assert.equal(out.outcome, "BLOCKED", JSON.stringify(out));
assert.match(out.message, /Discount at most 5%/);
s = await state();
assert.equal(s.proposals.find((p) => p.id === waitSettle.id).status, "pending", "a blocked proposal must not replace a waiting one");
pass("an outside agent asking for 20% off is blocked by the same mandate, and the waiting 5% offer survives");

r = await mcp("tools/call", { name: "propose_action", arguments: { type: "accept_dispute_claim", target_id: "PP-D-8821", note: "Refunding.", rationale: "Small dispute." } });
out = toolJson(r);
assert.equal(out.outcome, "BLOCKED");
assert.match(out.message, /key allows it/);
pass("the agent key's scope blocks dispute concessions for outside agents");

r = await mcp("tools/call", { name: "propose_action", arguments: { type: "send_reminder", target_id: halden.invoice_id, subject: "Invoice INV-2044 is due soon", note: "Hello, a heads-up that INV-2044 for $1,200 is due next week. Accounts", rationale: "Early nudge." } });
out = toolJson(r);
assert.equal(out.outcome, "EXECUTED_UNDER_STANDING_MANDATE", JSON.stringify(out));
const viaId = out.proposal_id;
r = await mcp("tools/call", { name: "get_proposal", arguments: { proposal_id: viaId } });
assert.equal(toolJson(r).outcome, "EXECUTED_UNDER_STANDING_MANDATE");
s = await state();
const viaP = s.proposals.find((p) => p.id === viaId);
assert.equal(viaP.origin, "mcp");
assert.equal(viaP.via, "e2e-agent");
assert.ok(s.agents.recent.length >= 4);
pass("an outside agent's reminder runs on autopilot and shows up in the cockpit as coming via MCP");

// ================= stdio bridge (what Claude Desktop runs) =================
const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = spawn(process.execPath, [path.join(here, "mcp-stdio.mjs")], { env: { ...process.env, PPG_URL: BASE + "/api/mcp", PPG_AGENT_KEY: key }, stdio: ["pipe", "pipe", "pipe"] });
const lines = [];
let buf = "";
bridge.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    lines.push(JSON.parse(buf.slice(0, i)));
    buf = buf.slice(i + 1);
  }
});
const waitFor = async (id) => {
  for (let t = 0; t < 100; t++) {
    const m = lines.find((l) => l.id === id);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`bridge gave no answer for id ${id}`);
};
bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "0.0" } } }) + "\n");
const init = await waitFor(1);
bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_mandate", arguments: {} } }) + "\n");
const mand = await waitFor(2);
bridge.kill();
assert.equal(init.result.serverInfo.name, "paypulse-guard");
assert.equal(JSON.parse(mand.result.content[0].text).maxDiscountPct, 5);
s = await state();
assert.equal(s.agents.lastClient, "Claude Desktop");
pass("the stdio bridge Claude Desktop uses completes a handshake and a tool call");

// ================= AG Studio analytics =================
s = await state();
r = await call("/api/analytics");
assert.equal(r.status, 200);
for (const t of ["invoices", "actions", "refusals", "ledger"]) assert.ok(Array.isArray(r.data[t]) && r.data[t].length > 0, `analytics table ${t} is empty`);
assert.equal(Math.round(r.data.invoices.reduce((a, i) => a + (i.amount_due || 0), 0)), Math.round(s.metrics.outstanding));
assert.ok(r.data.actions.some((a) => /via MCP$/.test(a.proposed_by)), "MCP proposals should reach analytics");
// ("Agent key" refusals are rate-limited to one ledger line a minute, so they are not asserted here.)
assert.ok(["Mandate", "Signature", "Autopilot"].every((st) => r.data.refusals.some((x) => x.stage === st)), "every guard stage should show up in refusals");
const ai = await call("/api/analytics/ai", { method: "POST", body: { messages: [{ role: "user", content: "hi" }] }, auth: false });
assert.equal(ai.status, 401);
pass(`analytics feed matches the cockpit (${r.data.invoices.length} invoices, ${r.data.actions.length} proposals, ${r.data.refusals.length} refusals) and the assistant needs the operator session`);

s = await state();
assert.equal(s.chain.ok, true);

console.log(`\n${n} checks passed.`);
