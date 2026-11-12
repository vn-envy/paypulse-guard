import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentKey, LedgerEntry, McpCall, Proposal, StandingMandate } from "./types";

export type Store = {
  secret: string;
  proposals: Proposal[];
  ledger: LedgerEntry[];
  // invoiceId -> last executed agent action on it
  touched: Record<string, { ts: string; type: string; proposalId: string }>;
  lastStatus: Record<string, string>;
  recovered: { invoiceId: string; number: string; amount: number; currency: string; ts: string }[];
  concessions: { ts: string; amount: number; proposalId: string }[];
  emulator: any | null;
  agentRunning: boolean;
  lastRun: { ts: string; planner: string; summary: string } | null;
  standing: StandingMandate | null;
  agentKey: AgentKey | null;
  mcpSessions: Record<string, { client: string; raw: string; ts: string }>;
  mcpCalls: McpCall[];
};

const FILE = path.join(process.cwd(), ".data", "state.json");
const g = globalThis as unknown as { __ppg?: Store };

function fresh(): Store {
  return {
    secret: process.env.GUARD_SECRET || crypto.randomBytes(32).toString("hex"),
    proposals: [],
    ledger: [],
    touched: {},
    lastStatus: {},
    recovered: [],
    concessions: [],
    emulator: null,
    agentRunning: false,
    lastRun: null,
    standing: null,
    agentKey: null,
    mcpSessions: {},
    mcpCalls: [],
  };
}

export function store(): Store {
  if (!g.__ppg) {
    let s = fresh();
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
      s = { ...s, ...raw, agentRunning: false };
      if (process.env.GUARD_SECRET) s.secret = process.env.GUARD_SECRET;
    } catch {
      /* first boot */
    }
    g.__ppg = s;
  }
  return g.__ppg;
}

let timer: NodeJS.Timeout | null = null;
export function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(store()));
    } catch {
      /* read-only filesystem: state stays in memory */
    }
  }, 150);
}

/** Clears proposals, ledger, autopilot and emulator data. Keeps the signing secret and the agent key, so connected agents stay connected. */
export function resetStore() {
  const { secret, agentKey, mcpSessions } = store();
  g.__ppg = { ...fresh(), secret, agentKey, mcpSessions };
  persist();
}
