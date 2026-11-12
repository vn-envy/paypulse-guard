export type Money = { currency: string; value: number };

export type Receivable = {
  id: string;
  number: string;
  client: string;
  email: string;
  milestone: string;
  status: string; // raw PayPal status
  collectible: boolean;
  paid: boolean;
  currency: string;
  total: number;
  due: number;
  dueDate: string | null;
  daysOverdue: number; // negative = days until due
  payUrl: string | null;
  note: string;
  paidDate: string | null;
  // CLLA benchmark for a debt this many days past due (0..1). Null when not overdue or not collectible.
  collectability: number | null;
  // This client's record on this PayPal account: paid invoices and how late they were on average.
  usual: { paidCount: number; avgDaysLate: number } | null;
};

export type Dispute = {
  id: string;
  reason: string;
  status: string;
  stage: string;
  currency: string;
  amount: number;
  createdAt: string | null;
  buyerMessage: string;
};

export type Action =
  | { type: "send_reminder"; invoiceId: string; subject: string; note: string }
  | { type: "offer_settlement"; invoiceId: string; discountPct: number; note: string }
  | { type: "accept_dispute_claim"; disputeId: string; note: string }
  // Anything else an agent invents. Never in the mandate.
  | { type: string; [k: string]: unknown };

export type Check = { rule: string; pass: boolean; detail: string };

export type Verdict = {
  decision: "needs_signature" | "blocked";
  checks: Check[];
  exposure: number; // money this action gives away or moves
  currency: string;
};

export type PayPalCall = {
  method: string;
  path: string;
  status: number;
  requestId: string;
  debugId: string | null;
};

export type Proposal = {
  id: string;
  createdAt: string;
  origin: "agent" | "mcp" | "redteam";
  planner: string;
  // For MCP proposals: which client sent it, e.g. "Claude Desktop".
  via?: string;
  action: Action;
  hash: string;
  targetLabel: string;
  rationale: string;
  // Facts the guard attached from PayPal history and public benchmarks, shown to the approver.
  evidence?: string[];
  verdict: Verdict;
  status: "pending" | "blocked" | "executed" | "rejected" | "failed" | "superseded";
  // Whether the owner's standing mandate covered this, and why not when it didn't.
  autopilot?: { covered: boolean; note: string; mandateId?: string };
  approval?: { approver: string; exp: number; sig: string };
  calls?: PayPalCall[];
  resultNote?: string;
};

export type LedgerEntry = {
  seq: number;
  ts: string;
  // agent, guard, operator, autopilot, paypal, attacker, or the name of an MCP client
  actor: string;
  event: string;
  target: string;
  detail: string;
  outcome: "ok" | "denied" | "info";
  amount?: number;
  currency?: string;
  call?: PayPalCall;
  prev: string;
  hash: string;
};

export type Policy = {
  allowedActions: string[];
  maxDiscountPct: number;
  maxConcessionPerAction: number;
  dailyConcessionBudget: number;
  maxDisputeConcession: number;
  minDaysOverdueForSettlement: number;
  reminderCooldownHours: number;
  settlementHorizonDays: number;
  approvalTtlSeconds: number;
};

/**
 * A standing mandate: limits the owner signs once, inside which agent proposals run without a
 * per-action signature. The same idea as an AP2 Intent Mandate for "human not present" tasks.
 */
export type StandingMandate = {
  id: string;
  createdAt: string;
  expiresAt: number; // unix seconds
  reminders: boolean;
  maxDiscountPct: number; // 0 = settlements not covered
  budget: number; // the most this mandate may give up in total
  currency: string;
  spent: number;
  executed: number;
  sig: string; // HMAC over the terms above, minted only in an operator session
  revokedAt?: string;
};

/** Credential for external agents connecting over MCP. It can read and propose. Nothing else. */
export type AgentKey = {
  key: string;
  scope: string[]; // action types this key may propose
  createdAt: string;
  lastClient: string | null;
  lastSeen: string | null;
};

export type McpCall = { ts: string; client: string; tool: string; summary: string; outcome: "ok" | "denied" | "info" };
