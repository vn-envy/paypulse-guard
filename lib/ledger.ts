import crypto from "node:crypto";
import { persist, store } from "./store";
import type { LedgerEntry } from "./types";

const GENESIS = "0".repeat(64);

function digest(e: Omit<LedgerEntry, "hash">) {
  return crypto.createHash("sha256").update(JSON.stringify(e)).digest("hex");
}

/** Append-only, hash-chained audit log. Each entry commits to the one before it. */
export function record(e: Omit<LedgerEntry, "seq" | "ts" | "prev" | "hash">): LedgerEntry {
  const s = store();
  const prev = s.ledger.length ? s.ledger[s.ledger.length - 1].hash : GENESIS;
  const body = { ...e, seq: s.ledger.length + 1, ts: new Date().toISOString(), prev };
  const entry: LedgerEntry = { ...body, hash: digest(body) };
  s.ledger.push(entry);
  persist();
  return entry;
}

export function verifyChain(): { ok: boolean; brokenAt: number | null } {
  let prev = GENESIS;
  for (const e of store().ledger) {
    const { hash, ...body } = e;
    if (body.prev !== prev || digest(body) !== hash) return { ok: false, brokenAt: e.seq };
    prev = hash;
  }
  return { ok: true, brokenAt: null };
}
