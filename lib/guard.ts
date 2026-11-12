import crypto from "node:crypto";
import { executeOnPayPal } from "./actions";
import { collectability, waitCostPoints } from "./benchmarks";
import { record } from "./ledger";
import { book, invalidateBook } from "./receivables";
import { persist, store } from "./store";
import type { Action, Check, Policy, Proposal, StandingMandate, Verdict } from "./types";

/**
 * The mandate. This is the whole of what an agent is allowed to ask for.
 * The agent can read it, but only this file enforces it.
 */
export const POLICY: Policy = {
  allowedActions: ["send_reminder", "offer_settlement", "accept_dispute_claim"],
  maxDiscountPct: 5,
  maxConcessionPerAction: 250,
  dailyConcessionBudget: 400,
  maxDisputeConcession: 50,
  minDaysOverdueForSettlement: 7,
  reminderCooldownHours: 48,
  settlementHorizonDays: 30,
  approvalTtlSeconds: 300,
};

// ---------- canonical hashing & signatures ----------

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export const hashAction = (a: Action) => crypto.createHash("sha256").update(canonical(a)).digest("hex");

const hmac = (msg: string) => crypto.createHmac("sha256", store().secret).update(msg).digest("hex");

function safeEq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** An approval is a signature over one proposal id, one exact payload hash and an expiry. */
export function mintApproval(proposalId: string, hash: string, approver: string, exp = Math.floor(Date.now() / 1000) + POLICY.approvalTtlSeconds) {
  return { approver, exp, sig: hmac(`approve.${proposalId}.${hash}.${approver}.${exp}`) };
}

// ---------- operator session (the human) ----------

export const OPERATOR_COOKIE = "ppg_operator";

export function checkPin(pin: string) {
  return safeEq(String(pin ?? ""), process.env.GUARD_OPERATOR_PIN || "2468");
}

export function mintOperatorSession(ttlSeconds = 1800) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { value: `${exp}.${hmac(`operator.${exp}`)}`, exp };
}

export function operatorFromCookie(value: string | undefined): { ok: boolean; exp: number } {
  if (!value) return { ok: false, exp: 0 };
  const [expStr, sig] = value.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now() / 1000) return { ok: false, exp: 0 };
  return { ok: safeEq(sig, hmac(`operator.${exp}`)), exp };
}

// ---------- standing mandate (autopilot) ----------

const money = (n: number, c: string) => `${c} ${n.toFixed(2)}`;

export const ACTION_LABEL: Record<string, string> = {
  send_reminder: "reminders",
  offer_settlement: "settlements",
  accept_dispute_claim: "dispute concessions",
};

function standingTerms(sm: Pick<StandingMandate, "id" | "reminders" | "maxDiscountPct" | "budget" | "currency" | "expiresAt">) {
  const { id, reminders, maxDiscountPct, budget, currency, expiresAt } = sm;
  return `standing.${canonical({ id, reminders, maxDiscountPct, budget, currency, expiresAt })}`;
}

/** Only called from a route that has already checked the operator session. */
export function signStanding(input: { reminders: boolean; maxDiscountPct: number; budget: number; days: number; currency: string }): StandingMandate {
  const terms = {
    id: "sm_" + crypto.randomBytes(5).toString("hex"),
    reminders: !!input.reminders,
    maxDiscountPct: input.maxDiscountPct,
    budget: input.budget,
    currency: input.currency,
    expiresAt: Math.floor(Date.now() / 1000) + Math.round(input.days * 86_400),
  };
  return { ...terms, createdAt: new Date().toISOString(), spent: 0, executed: 0, sig: hmac(standingTerms(terms)) };
}

export function standingValid(sm: StandingMandate) {
  return safeEq(sm.sig, hmac(standingTerms(sm)));
}

export function activeStanding(): StandingMandate | null {
  const sm = store().standing;
  return sm && !sm.revokedAt && sm.expiresAt > Date.now() / 1000 ? sm : null;
}

/**
 * Does the owner's standing mandate cover this action? Nothing that moves money for a dispute
 * is ever covered, and a mandate whose terms do not match its signature is ignored.
 */
export function autopilotCovers(action: Action, verdict: Verdict, sm: StandingMandate | null): { covered: boolean; note: string; sm?: StandingMandate; tampered?: boolean } {
  if (!sm || sm.revokedAt) return { covered: false, note: "" };
  if (sm.expiresAt <= Date.now() / 1000) return { covered: false, note: "Autopilot has expired." };
  if (!standingValid(sm)) return { covered: false, note: "The standing mandate's terms do not match the signature you gave them, so the guard ignored it.", tampered: true };
  if (action.type === "send_reminder") {
    return sm.reminders ? { covered: true, note: "Reminders are covered by autopilot.", sm } : { covered: false, note: "Autopilot does not cover reminders." };
  }
  if (action.type === "offer_settlement") {
    const pct = Number((action as any).discountPct);
    if (!(sm.maxDiscountPct > 0) || !(sm.budget > 0)) return { covered: false, note: "Autopilot does not cover settlements." };
    if (!(pct <= sm.maxDiscountPct)) return { covered: false, note: `${pct}% is above autopilot's ${sm.maxDiscountPct}% limit.` };
    const after = Math.round((sm.spent + verdict.exposure) * 100) / 100;
    if (after > sm.budget) return { covered: false, note: `This would bring autopilot to ${money(after, sm.currency)} of its ${money(sm.budget, sm.currency)} budget.` };
    return { covered: true, note: `Within autopilot: ${pct}% off, ${money(after, sm.currency)} of ${money(sm.budget, sm.currency)} used.`, sm };
  }
  if (action.type === "accept_dispute_claim") return { covered: false, note: "Disputes always wait for you." };
  return { covered: false, note: "" };
}

// ---------- policy evaluation ----------

function concededToday() {
  const since = Date.now() - 86_400_000;
  return store()
    .concessions.filter((c) => new Date(c.ts).getTime() > since)
    .reduce((a, c) => a + c.amount, 0);
}

export async function evaluate(action: Action, opts: { fresh?: boolean } = {}): Promise<{ verdict: Verdict; targetLabel: string }> {
  const checks: Check[] = [];
  const add = (rule: string, pass: boolean, detail: string) => checks.push({ rule, pass, detail });
  let exposure = 0;
  let currency = "USD";
  let targetLabel = String((action as any).invoiceId ?? (action as any).disputeId ?? (action as any).target ?? "unknown");

  const allowed = POLICY.allowedActions.includes(action.type);
  add("Action is in the mandate", allowed, allowed ? action.type : `"${action.type}" is not an action this agent may ask for`);

  const b = await book(opts.fresh);

  if (!allowed) {
    exposure = Number((action as any).amount ?? 0) || 0;
    targetLabel = b.receivables.find((r) => r.id === targetLabel)?.number ?? targetLabel;
    currency = String((action as any).currency ?? "USD");
  } else if (action.type === "send_reminder" || action.type === "offer_settlement") {
    const a = action as Extract<Action, { invoiceId: string }>;
    const inv = b.receivables.find((r) => r.id === a.invoiceId);
    add("Invoice exists on PayPal", !!inv, inv ? `${inv.number}, ${inv.client}` : `No invoice ${a.invoiceId}`);
    if (inv) {
      targetLabel = inv.number;
      currency = inv.currency;
      add("Invoice is still unpaid", inv.collectible, `PayPal status ${inv.status}`);
      const note = String((a as any).note ?? "");
      add("Message is present and under 1,000 characters", note.length > 0 && note.length <= 1000, `${note.length} characters`);

      if (action.type === "send_reminder") {
        const last = store().touched[inv.id];
        const hours = last && last.type === "send_reminder" ? (Date.now() - new Date(last.ts).getTime()) / 3_600_000 : Infinity;
        add(
          `No reminder in the last ${POLICY.reminderCooldownHours}h`,
          hours >= POLICY.reminderCooldownHours,
          hours === Infinity ? "None sent by this agent" : `Last reminder ${hours.toFixed(1)}h ago`,
        );
      } else {
        const pct = Number((action as any).discountPct);
        const validPct = Number.isFinite(pct) && pct > 0;
        exposure = validPct ? Math.round(inv.due * pct) / 100 : inv.due;
        add(`Discount at most ${POLICY.maxDiscountPct}%`, validPct && pct <= POLICY.maxDiscountPct, validPct ? `${pct}% requested` : "Invalid discount");
        add(
          `Concession at most ${money(POLICY.maxConcessionPerAction, currency)}`,
          exposure <= POLICY.maxConcessionPerAction,
          `${money(exposure, currency)} given up on ${money(inv.due, currency)}`,
        );
        add(
          `At least ${POLICY.minDaysOverdueForSettlement} days overdue`,
          inv.daysOverdue >= POLICY.minDaysOverdueForSettlement,
          inv.daysOverdue > 0 ? `${inv.daysOverdue} days overdue` : "Not overdue",
        );
        // A discount only makes sense if it costs less than the benchmark says waiting would.
        const lost = waitCostPoints(inv.daysOverdue, POLICY.settlementHorizonDays);
        add(
          `Discount is under the benchmark cost of waiting ${POLICY.settlementHorizonDays} more days`,
          validPct && pct <= lost,
          `${validPct ? pct : "?"}% off against ${lost} points of collectability lost (CLLA curve)`,
        );
      }
    }
  } else if (action.type === "accept_dispute_claim") {
    const a = action as Extract<Action, { disputeId: string }>;
    const d = b.disputes.find((x) => x.id === a.disputeId);
    add("Dispute exists on PayPal", !!d, d ? `${d.id}, ${d.reason}` : `No dispute ${a.disputeId}`);
    if (d) {
      targetLabel = d.id;
      currency = d.currency;
      exposure = d.amount;
      add("Dispute is waiting for the seller", d.status === "WAITING_FOR_SELLER_RESPONSE", `PayPal status ${d.status}`);
      add(
        `Refund at most ${money(POLICY.maxDisputeConcession, currency)}`,
        d.amount <= POLICY.maxDisputeConcession,
        `${money(d.amount, currency)} would be refunded`,
      );
    }
  }

  if (allowed && exposure > 0) {
    const used = concededToday();
    add(
      `Daily concession budget ${money(POLICY.dailyConcessionBudget, currency)}`,
      used + exposure <= POLICY.dailyConcessionBudget,
      `${money(used, currency)} used in the last 24h, this adds ${money(exposure, currency)}`,
    );
  }

  const decision = checks.every((c) => c.pass) ? "needs_signature" : "blocked";
  return { verdict: { decision, checks, exposure, currency }, targetLabel };
}

// ---------- evidence shown to the approver ----------

async function evidenceFor(action: Action): Promise<string[]> {
  const id = (action as any).invoiceId;
  if (!id) return [];
  const inv = (await book()).receivables.find((r) => r.id === id);
  if (!inv) return [];
  const out: string[] = [];
  if (inv.usual) {
    const u = inv.usual;
    const usual = u.avgDaysLate < 0.5 ? "on time" : `about ${Math.round(u.avgDaysLate)} day${Math.round(u.avgDaysLate) === 1 ? "" : "s"} late`;
    out.push(`PayPal history: ${inv.client} paid ${u.paidCount} earlier invoice${u.paidCount === 1 ? "" : "s"} ${usual}. This one is ${inv.daysOverdue} days late.`);
  } else {
    out.push(`PayPal history: no paid invoices from ${inv.client} on this account yet.`);
  }
  if (inv.daysOverdue > 0) {
    const now = Math.round(collectability(inv.daysOverdue) * 100);
    const later = Math.round(collectability(inv.daysOverdue + POLICY.settlementHorizonDays) * 100);
    out.push(`CLLA benchmark: commercial debt this late is collected about ${now}% of the time, falling to ${later}% in ${POLICY.settlementHorizonDays} more days.`);
  }
  return out;
}

// ---------- proposing ----------

export async function propose(input: {
  action: Action;
  rationale: string;
  origin: Proposal["origin"];
  planner: string;
  via?: string; // MCP client name
  scope?: string[]; // action types the caller's key may propose; undefined = the built-in agent
  autopilot?: boolean; // let a standing mandate execute it; off by default for the red team
  standingOverride?: StandingMandate | null; // red team only: present a forged standing mandate
}): Promise<Proposal> {
  const s = store();
  const { verdict, targetLabel } = await evaluate(input.action);
  if (input.scope && !input.scope.includes(input.action.type)) {
    const allowed = input.scope.map((t) => ACTION_LABEL[t] ?? t).join(", ") || "nothing";
    verdict.checks.unshift({ rule: "This agent's key allows it", pass: false, detail: `this key may only propose ${allowed}` });
    verdict.decision = "blocked";
  }
  const hash = hashAction(input.action);

  // A new acceptable proposal for the same target replaces an older undecided one. A blocked one replaces nothing.
  if (input.origin !== "redteam" && verdict.decision !== "blocked") {
    for (const p of s.proposals) {
      if ((p.origin === "agent" || p.origin === "mcp") && p.status === "pending" && p.targetLabel === targetLabel) p.status = "superseded";
    }
  }

  const p: Proposal = {
    id: "prop_" + crypto.randomBytes(6).toString("hex"),
    createdAt: new Date().toISOString(),
    origin: input.origin,
    planner: input.planner,
    via: input.via,
    action: input.action,
    hash,
    targetLabel,
    rationale: input.rationale,
    evidence: await evidenceFor(input.action),
    verdict,
    status: verdict.decision === "blocked" ? "blocked" : "pending",
  };
  s.proposals.push(p);

  const actor = input.origin === "redteam" ? "attacker" : input.origin === "mcp" ? (input.via ?? "external agent") : "agent";
  record({ actor, event: "proposed", target: targetLabel, detail: `${input.action.type}: ${input.rationale}`.slice(0, 400), outcome: "info", amount: verdict.exposure || undefined, currency: verdict.currency });
  if (verdict.decision === "blocked") {
    const failed = verdict.checks.filter((c) => !c.pass).map((c) => `${c.rule} (${c.detail})`).join("; ");
    record({ actor: "guard", event: "blocked_by_mandate", target: targetLabel, detail: failed, outcome: "denied", amount: verdict.exposure || undefined, currency: verdict.currency });
  }

  const useAutopilot = input.autopilot ?? input.origin !== "redteam";
  if (p.status === "pending" && useAutopilot) {
    const sm = input.standingOverride !== undefined ? input.standingOverride : store().standing;
    const cov = autopilotCovers(input.action, verdict, sm);
    p.autopilot = { covered: cov.covered, note: cov.note, mandateId: cov.sm?.id };
    if (cov.tampered) {
      record({ actor: "guard", event: "denied_autopilot_tampered", target: targetLabel, detail: `Standing mandate ${sm?.id} failed its signature check. Ignored; the action waits for the operator.`, outcome: "denied", amount: verdict.exposure || undefined, currency: verdict.currency });
    }
    if (cov.covered && cov.sm) {
      persist();
      await execute({ proposalId: p.id, action: input.action, approval: mintApproval(p.id, hash, `autopilot:${cov.sm.id}`) });
    }
  }
  persist();
  return p;
}

// ---------- executing ----------

export type ExecResult = { ok: boolean; code: string; reason: string; proposal?: Proposal };

function deny(p: Proposal | undefined, actor: "guard", code: string, reason: string, target: string, exposure?: number, currency?: string, by: "agent" | "attacker" = "agent"): ExecResult {
  record({ actor, event: `denied_${code}`, target, detail: `${reason} Caller: ${by}.`, outcome: "denied", amount: exposure || undefined, currency });
  return { ok: false, code, reason, proposal: p };
}

/**
 * The only door to a PayPal write. It takes the payload the caller wants to run,
 * not the payload on file, and refuses unless a valid signature covers exactly that payload.
 */
export async function execute(input: {
  proposalId: string;
  action: Action;
  approval?: { approver: string; exp: number; sig: string } | null;
  caller?: "agent" | "attacker";
}): Promise<ExecResult> {
  const s = store();
  const by = input.caller ?? "agent";
  const p = s.proposals.find((x) => x.id === input.proposalId);
  if (!p) return deny(undefined, "guard", "unknown_proposal", "No such proposal.", input.proposalId, undefined, undefined, by);

  const hash = hashAction(input.action);
  const pre = await evaluate(input.action).catch(() => null);
  const exposure = pre?.verdict.exposure ?? p.verdict.exposure;
  const cur = pre?.verdict.currency ?? p.verdict.currency;
  const d = (code: string, reason: string) => deny(p, "guard", code, reason, p.targetLabel, exposure, cur, by);

  if (!input.approval) return d("no_signature", "No operator signature was presented.");
  if (input.approval.exp < Date.now() / 1000) return d("signature_expired", "The signature has expired.");
  const expected = mintApproval(p.id, hash, input.approval.approver, input.approval.exp).sig;
  if (!safeEq(expected, input.approval.sig)) {
    return hash !== p.hash
      ? d("payload_tampered", "The payload differs from the one that was signed. The signature does not cover it.")
      : d("bad_signature", "Signature is not valid.");
  }
  if (p.status === "executed") return d("replay", "This signature was already used. A signature executes once.");
  if (p.status !== "pending") return d("not_pending", `Proposal is ${p.status}, not awaiting signature.`);

  // Re-check the mandate against PayPal as it is right now, not as it was when proposed.
  const { verdict } = await evaluate(input.action, { fresh: true });
  if (verdict.decision === "blocked") {
    p.status = "blocked";
    p.verdict = verdict;
    persist();
    const failed = verdict.checks.filter((c) => !c.pass).map((c) => `${c.rule} (${c.detail})`).join("; ");
    return d("mandate_recheck_failed", `State changed since proposal: ${failed}`);
  }

  // An autopilot approval is only as good as the standing mandate behind it, checked again here.
  const autoId = input.approval.approver.startsWith("autopilot:") ? input.approval.approver.slice("autopilot:".length) : null;
  const sm = autoId ? store().standing : null;
  if (autoId) {
    const cov = autopilotCovers(input.action, verdict, sm);
    if (!cov.covered || cov.sm?.id !== autoId) return d("autopilot_not_covering", cov.note || "No standing mandate covers this action.");
  }

  p.approval = input.approval;
  if (sm) {
    const after = Math.round((sm.spent + verdict.exposure) * 100) / 100;
    record({ actor: "autopilot", event: "auto_signed", target: p.targetLabel, detail: `Covered by standing mandate ${sm.id}, which the operator signed. ${money(after, sm.currency)} of ${money(sm.budget, sm.currency)} used.`, outcome: "ok", amount: verdict.exposure || undefined, currency: verdict.currency });
  } else {
    record({ actor: "operator", event: "signed", target: p.targetLabel, detail: `${input.approval.approver} signed payload ${hash.slice(0, 12)}…`, outcome: "ok", amount: verdict.exposure || undefined, currency: verdict.currency });
  }

  // PayPal-Request-Id is derived from the signed payload, so a retry cannot double-execute.
  const h = crypto.createHash("sha256").update(`${p.id}.${hash}`).digest("hex");
  const baseRequestId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 30)}`;

  const out = await executeOnPayPal(p.action, baseRequestId);
  p.calls = out.calls;
  p.resultNote = out.note;
  for (const c of out.calls) {
    record({ actor: "paypal", event: c.status < 400 ? "api_ok" : "api_error", target: p.targetLabel, detail: `${c.method} ${c.path} -> ${c.status}`, outcome: c.status < 400 ? "ok" : "denied", call: c });
  }
  if (out.ok) {
    p.status = "executed";
    const ts = new Date().toISOString();
    for (const id of out.touchedInvoiceIds) s.touched[id] = { ts, type: p.action.type, proposalId: p.id };
    if (verdict.exposure > 0) s.concessions.push({ ts, amount: verdict.exposure, proposalId: p.id });
    if (sm) {
      sm.spent = Math.round((sm.spent + verdict.exposure) * 100) / 100;
      sm.executed += 1;
    }
    record({ actor: "guard", event: "executed", target: p.targetLabel, detail: out.note, outcome: "ok", amount: verdict.exposure || undefined, currency: verdict.currency });
  } else {
    p.status = "failed";
    record({ actor: "guard", event: "execution_failed", target: p.targetLabel, detail: out.note, outcome: "denied" });
  }
  invalidateBook();
  persist();
  return { ok: out.ok, code: out.ok ? "executed" : "paypal_error", reason: out.note, proposal: p };
}
