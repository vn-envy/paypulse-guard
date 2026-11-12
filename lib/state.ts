import path from "node:path";
import { llmConfig, plannerLabel } from "./agent";
import { CLLA_CURVE, SOURCES } from "./benchmarks";
import { POLICY, activeStanding } from "./guard";
import { agentKey } from "./mcp";
import { verifyChain } from "./ledger";
import { paypalMode } from "./paypal";
import { book } from "./receivables";
import { store } from "./store";

export async function snapshot(operator: { ok: boolean; exp: number }, fresh = false) {
  const s = store();
  const b = await book(fresh);
  const currency = b.receivables[0]?.currency ?? "USD";
  const same = b.receivables.filter((r) => r.currency === currency);
  const open = same.filter((r) => r.collectible && r.due > 0);
  const denied = s.ledger.filter((e) => e.outcome === "denied" && e.actor === "guard");
  const sm = activeStanding();
  const ak = agentKey();
  return {
    mode: paypalMode(),
    planner: plannerLabel(),
    llm: llmConfig().enabled,
    webhook: !!process.env.PAYPAL_WEBHOOK_ID,
    operator: { unlocked: operator.ok, exp: operator.exp },
    errors: b.errors,
    currency,
    metrics: {
      outstanding: open.reduce((a, r) => a + r.due, 0),
      overdue: open.filter((r) => r.daysOverdue > 0).reduce((a, r) => a + r.due, 0),
      overdueCount: open.filter((r) => r.daysOverdue > 0).length,
      recovered: s.recovered.filter((r) => r.currency === currency).reduce((a, r) => a + r.amount, 0),
      recoveredCount: s.recovered.length,
      stopped: denied.reduce((a, e) => a + (e.amount ?? 0), 0),
      stoppedCount: denied.length,
      // Benchmark expected shortfall on overdue invoices if nothing is done: sum of due x (1 - collectability).
      atRisk: open.reduce((a, r) => a + (r.collectability === null ? 0 : r.due * (1 - r.collectability)), 0),
      avgDaysLate: (() => {
        const late = open.filter((r) => r.daysOverdue > 0);
        const total = late.reduce((a, r) => a + r.due, 0);
        return total ? Math.round(late.reduce((a, r) => a + r.due * r.daysOverdue, 0) / total) : 0;
      })(),
    },
    benchmarks: { curve: CLLA_CURVE, sources: SOURCES },
    receivables: b.receivables.map((r) => ({ ...r, lastAction: s.touched[r.id] ?? null })),
    disputes: b.disputes,
    proposals: s.proposals.filter((p) => (p.origin === "agent" || p.origin === "mcp") && p.status !== "superseded").slice(-14).reverse(),
    autopilot: {
      on: !!sm,
      id: sm?.id ?? null,
      reminders: sm?.reminders ?? false,
      maxDiscountPct: sm?.maxDiscountPct ?? 0,
      budget: sm?.budget ?? 0,
      spent: sm?.spent ?? 0,
      executed: sm?.executed ?? 0,
      expiresAt: sm?.expiresAt ?? 0,
    },
    agents: {
      // The key and the local paths are credentials and machine details: only for the unlocked operator.
      key: operator.ok ? ak.key : null,
      pinned: !!process.env.GUARD_AGENT_KEY,
      scope: ak.scope,
      lastClient: ak.lastClient,
      lastSeen: ak.lastSeen,
      recent: s.mcpCalls.slice(-8).reverse(),
      stdio: operator.ok ? { node: process.execPath, script: path.join(process.cwd(), "scripts", "mcp-stdio.mjs") } : null,
    },
    ledger: s.ledger.slice(-60).reverse(),
    ledgerSize: s.ledger.length,
    chain: verifyChain(),
    policy: POLICY,
    lastRun: s.lastRun,
    agentRunning: s.agentRunning,
  };
}
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
