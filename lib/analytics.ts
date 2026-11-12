import { book } from "./receivables";
import { store } from "./store";
import type { Proposal, Receivable } from "./types";

/**
 * Flat tables for the AG Studio analytics page: receivables from PayPal, every proposal any agent
 * made, every refusal the guard issued, and the audit ledger. Plain JSON; dates are ISO strings.
 */

const ACTION_NAME: Record<string, string> = {
  send_reminder: "Reminder",
  offer_settlement: "Settlement",
  accept_dispute_claim: "Dispute concession",
  refund_payment: "Refund (outside the mandate)",
};

const DENIAL: Record<string, { stage: string; reason: string }> = {
  denied_no_signature: { stage: "Signature", reason: "No signature presented" },
  denied_payload_tampered: { stage: "Signature", reason: "Payload changed after signing" },
  denied_replay: { stage: "Signature", reason: "Signature reused" },
  denied_signature_expired: { stage: "Signature", reason: "Signature expired" },
  denied_bad_signature: { stage: "Signature", reason: "Invalid signature" },
  denied_no_operator: { stage: "Signature", reason: "No operator session" },
  denied_not_pending: { stage: "Signature", reason: "Not awaiting a signature" },
  denied_unknown_proposal: { stage: "Signature", reason: "Unknown proposal" },
  denied_mandate_recheck_failed: { stage: "Mandate", reason: "Failed the re-check at execution" },
  denied_autopilot_tampered: { stage: "Autopilot", reason: "Standing mandate forged" },
  denied_autopilot_not_covering: { stage: "Autopilot", reason: "Outside the standing mandate" },
  mcp_refused: { stage: "Agent key", reason: "MCP call without a valid key" },
  webhook_refused: { stage: "Webhook", reason: "Unverified webhook" },
  unlock_failed: { stage: "Operator", reason: "Wrong operator PIN" },
};

/** Mandate rules, phrased as the reason something was refused. */
const RULE_REASON: [RegExp, string][] = [
  [/^Action is in the mandate/, "Action not allowed"],
  [/^Discount at most/, "Discount over the cap"],
  [/^Concession at most/, "Over the per-action limit"],
  [/^Daily concession budget/, "Over the daily budget"],
  [/^Discount is under the benchmark/, "Discount costs more than waiting"],
  [/^At least \d+ days overdue/, "Too early to settle"],
  [/^No reminder in the last/, "Reminded too recently"],
  [/^Invoice is still unpaid/, "Invoice already closed"],
  [/^Invoice exists/, "Unknown invoice"],
  [/^Dispute exists/, "Unknown dispute"],
  [/^Dispute is waiting/, "Dispute not open"],
  [/^Refund at most/, "Dispute over the limit"],
  [/^This agent's key allows it/, "Outside the agent key's scope"],
  [/^Message is present/, "Missing or long message"],
];
const reasonFor = (rule: string) => RULE_REASON.find(([re]) => re.test(rule))?.[1] ?? rule;

const AGE_BUCKETS: [number, string][] = [
  [7, "1 to 7 days late"],
  [14, "8 to 14 days late"],
  [30, "15 to 30 days late"],
  [60, "31 to 60 days late"],
  [Infinity, "Over 60 days late"],
];

function age(r: Receivable): { bucket: string; order: number } {
  if (r.paid) return { bucket: "Paid", order: 8 };
  if (!r.collectible) return { bucket: "Cancelled", order: 9 };
  if (r.daysOverdue <= 0) return { bucket: "Not due yet", order: 0 };
  const i = AGE_BUCKETS.findIndex(([max]) => r.daysOverdue <= max);
  return { bucket: AGE_BUCKETS[i][1], order: i + 1 };
}

function proposer(p: Proposal): string {
  if (p.origin === "redteam") return "Red team (simulated)";
  if (p.origin === "mcp") return `${p.via ?? "External agent"} via MCP`;
  return "Built-in agent";
}

function outcome(p: Proposal): string {
  switch (p.status) {
    case "executed":
      return p.approval?.approver.startsWith("autopilot:") ? "Ran on autopilot" : "Signed by you";
    case "pending":
      return "Waiting for you";
    case "blocked":
      return "Blocked by the guard";
    case "rejected":
      return p.origin === "redteam" ? "Stopped (attack)" : "Declined by you";
    case "failed":
      return "PayPal error";
    default:
      return "Replaced";
  }
}

export async function analyticsData() {
  const s = store();
  const b = await book();
  const currency = b.receivables[0]?.currency ?? "USD";
  const byId = new Map(b.receivables.map((r) => [r.id, r]));

  const ordered = [...b.receivables].sort((x, y) => age(x).order - age(y).order || y.daysOverdue - x.daysOverdue);
  const invoices = ordered.map((r) => {
    const late = r.collectible && r.daysOverdue > 0;
    const a = age(r);
    const last = s.touched[r.id];
    return {
      invoice_id: r.id,
      invoice: r.number,
      client: r.client,
      milestone: r.milestone || "No milestone",
      state: r.paid ? "Paid" : !r.collectible ? "Cancelled" : late ? "Late" : "Not due yet",
      age_bucket: a.bucket,
      age_order: a.order,
      amount: r.total,
      amount_due: r.collectible ? r.due : 0,
      late_amount: late ? r.due : 0,
      paid_amount: r.paid ? r.total : 0,
      due_date: r.dueDate,
      days_late: late ? r.daysOverdue : 0,
      usual_days_late: r.usual ? r.usual.avgDaysLate : null,
      beyond_usual: late ? Math.max(0, r.daysOverdue - (r.usual?.avgDaysLate ?? 0)) : 0,
      collectability: r.collectability === null ? null : Math.round(r.collectability * 1000) / 1000,
      at_risk: late && r.collectability !== null ? Math.round(r.due * (1 - r.collectability) * 100) / 100 : 0,
      last_agent_action: last ? ACTION_NAME[last.type] ?? last.type : "None",
    };
  });

  const proposals = s.proposals.filter((p) => p.status !== "superseded");
  const actions = proposals.map((p) => {
    const a = p.action as any;
    const inv = a.invoiceId ? byId.get(a.invoiceId) : undefined;
    const failed = p.verdict.checks.filter((c) => !c.pass);
    const exposure = p.verdict.exposure || 0;
    return {
      proposal_id: p.id,
      proposed_at: p.createdAt,
      proposed_by: proposer(p),
      model: p.planner,
      action: ACTION_NAME[p.action.type] ?? p.action.type,
      target: p.targetLabel,
      action_invoice_id: a.invoiceId ?? null,
      action_client: inv?.client ?? (a.disputeId ? "Dispute" : "Unknown"),
      outcome: outcome(p),
      discount_pct: Number.isFinite(Number(a.discountPct)) ? Number(a.discountPct) : null,
      given_up: exposure,
      given_up_executed: p.status === "executed" ? exposure : 0,
      stopped_amount: p.status === "blocked" || (p.origin === "redteam" && p.status !== "executed") ? exposure : 0,
      rules_broken: failed.length,
      first_broken_rule: failed[0]?.rule ?? "",
    };
  });

  const refusals: Record<string, unknown>[] = [];
  for (const p of proposals) {
    if (p.status !== "blocked") continue;
    p.verdict.checks
      .filter((c) => !c.pass)
      .forEach((c, i) =>
        refusals.push({
          refusal_id: `${p.id}:${i}`,
          refused_at: p.createdAt,
          stage: "Mandate",
          reason: reasonFor(c.rule),
          refused_who: proposer(p),
          refused_amount: p.verdict.exposure || 0,
        }),
      );
  }
  for (const e of s.ledger) {
    const d = DENIAL[e.event];
    if (!d || e.outcome !== "denied") continue;
    refusals.push({
      refusal_id: `L${e.seq}`,
      refused_at: e.ts,
      stage: d.stage,
      reason: d.reason,
      refused_who: /Caller: attacker/.test(e.detail) ? "Red team (simulated)" : e.event === "mcp_refused" ? "Unknown MCP client" : "Agent or caller",
      refused_amount: e.amount ?? 0,
    });
  }

  const ledger = s.ledger.map((e) => ({
    seq: e.seq,
    logged_at: e.ts,
    actor: e.actor,
    event: e.event.replaceAll("_", " "),
    result: e.outcome === "ok" ? "Allowed" : e.outcome === "denied" ? "Refused" : "Noted",
    subject: e.target,
    ledger_amount: e.amount ?? 0,
    detail: e.detail.slice(0, 240),
  }));

  return { currency, generatedAt: new Date().toISOString(), mode: b.errors.length ? "error" : "ok", invoices, actions, refusals, ledger };
}
export type AnalyticsData = Awaited<ReturnType<typeof analyticsData>>;
