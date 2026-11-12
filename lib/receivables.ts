import { collectability } from "./benchmarks";
import { record } from "./ledger";
import { pp } from "./paypal";
import { persist, store } from "./store";
import type { Dispute, Receivable } from "./types";

const COLLECTIBLE = new Set(["SENT", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING"]);
const PAID = new Set(["PAID", "MARKED_AS_PAID"]);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function clientName(inv: any): { client: string; email: string } {
  const b = inv.primary_recipients?.[0]?.billing_info ?? {};
  const person = [b.name?.given_name, b.name?.surname].filter(Boolean).join(" ");
  const email = b.email_address ?? "";
  return { client: b.business_name || person || b.name?.full_name || email || "Unknown client", email };
}

export function normalizeInvoice(inv: any): Receivable {
  const status = String(inv.status ?? "UNKNOWN");
  const total = num(inv.amount?.value);
  const paidAmt = num(inv.payments?.paid_amount?.value);
  const paid = PAID.has(status);
  const due = paid ? 0 : inv.due_amount?.value !== undefined ? num(inv.due_amount.value) : Math.max(total - paidAmt, 0);
  const dueDate: string | null = inv.detail?.payment_term?.due_date ?? null;
  const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
  const daysOverdue = dueDate ? Math.round((today - new Date(dueDate).getTime()) / 86_400_000) : 0;
  const { client, email } = clientName(inv);
  return {
    id: inv.id,
    number: inv.detail?.invoice_number ?? inv.id,
    client,
    email,
    milestone: inv.detail?.reference ?? "",
    status,
    collectible: COLLECTIBLE.has(status),
    paid,
    currency: inv.amount?.currency_code ?? inv.detail?.currency_code ?? "USD",
    total,
    due,
    dueDate,
    daysOverdue,
    payUrl: inv.detail?.metadata?.recipient_view_url ?? null,
    note: inv.detail?.note ?? "",
    paidDate: paid ? (inv.payments?.transactions ?? []).map((t: any) => t.payment_date).filter(Boolean).sort().pop() ?? null : null,
    collectability: COLLECTIBLE.has(status) && daysOverdue > 0 ? collectability(daysOverdue) : null,
    usual: null,
  };
}

function normalizeDispute(d: any): Dispute {
  const buyer = (d.messages ?? []).filter((m: any) => m.posted_by === "BUYER").map((m: any) => m.content).join(" \n ");
  return {
    id: d.dispute_id,
    reason: d.reason ?? "",
    status: d.status ?? "",
    stage: d.dispute_life_cycle_stage ?? "",
    currency: d.dispute_amount?.currency_code ?? "USD",
    amount: num(d.dispute_amount?.value),
    createdAt: d.create_time ?? null,
    buyerMessage: buyer,
  };
}

export type Book = { receivables: Receivable[]; disputes: Dispute[]; errors: string[]; fetchedAt: number };

const g = globalThis as unknown as { __ppgBook?: Book; __ppgBookP?: Promise<Book> | null };

async function load(): Promise<Book> {
  const errors: string[] = [];
  let receivables: Receivable[] = [];
  let disputes: Dispute[] = [];
  try {
    const r = await pp<any>("/v2/invoicing/invoices?page=1&page_size=100&total_required=true&fields=all");
    receivables = (r.data.items ?? []).filter((i: any) => i.status !== "DRAFT").map(normalizeInvoice);
    await fillPaidDates(receivables);
    attachClientHistory(receivables);
  } catch (e: any) {
    errors.push(`Invoices: ${e.message}`);
  }
  try {
    const r = await pp<any>("/v1/customer/disputes?page_size=20");
    disputes = (r.data.items ?? []).map(normalizeDispute);
  } catch (e: any) {
    errors.push(`Disputes: ${e.message}`);
  }
  if (!errors.some((e) => e.startsWith("Invoices"))) observeTransitions(receivables);
  return { receivables, disputes, errors, fetchedAt: Date.now() };
}

/**
 * The list endpoint leaves out payment transactions, so a paid invoice's payment date needs one
 * GET /invoices/{id}. Paid invoices don't change, so each date is fetched once per server process.
 */
const paidDates: Map<string, string | null> = ((globalThis as any).__ppgPaidDates ??= new Map());
async function fillPaidDates(list: Receivable[]) {
  const missing = list.filter((r) => r.paid && !r.paidDate && !paidDates.has(r.id)).slice(0, 25);
  await Promise.all(
    missing.map(async (r) => {
      try {
        const d = await pp<any>(`/v2/invoicing/invoices/${r.id}`);
        const date = (d.data?.payments?.transactions ?? []).map((t: any) => t.payment_date).filter(Boolean).sort().pop() ?? null;
        paidDates.set(r.id, date);
      } catch {
        /* try again on the next read */
      }
    }),
  );
  for (const r of list) if (r.paid && !r.paidDate) r.paidDate = paidDates.get(r.id) ?? null;
}

/** Per client: how many invoices they have paid on this account and how late, from PayPal's own records. */
function attachClientHistory(list: Receivable[]) {
  const byClient = new Map<string, number[]>();
  for (const r of list) {
    if (!r.paid || !r.paidDate || !r.dueDate) continue;
    const late = Math.max(0, Math.round((new Date(r.paidDate.slice(0, 10)).getTime() - new Date(r.dueDate).getTime()) / 86_400_000));
    const key = r.client.toLowerCase();
    byClient.set(key, [...(byClient.get(key) ?? []), late]);
  }
  for (const r of list) {
    const h = byClient.get(r.client.toLowerCase());
    if (h) r.usual = { paidCount: h.length, avgDaysLate: Math.round((h.reduce((a, b) => a + b, 0) / h.length) * 10) / 10 };
  }
}

/** Writes a ledger entry the first time PayPal reports an invoice as paid. */
function observeTransitions(list: Receivable[]) {
  const s = store();
  for (const r of list) {
    const before = s.lastStatus[r.id];
    if (before !== undefined && before !== r.status && r.paid) {
      const touched = s.touched[r.id];
      record({
        actor: "paypal",
        event: "invoice_paid",
        target: r.number,
        detail: touched
          ? `${r.client} paid after agent action "${touched.type}". PayPal status ${before} -> ${r.status}.`
          : `${r.client} paid. PayPal status ${before} -> ${r.status}.`,
        outcome: "ok",
        amount: r.total,
        currency: r.currency,
      });
      if (touched) s.recovered.push({ invoiceId: r.id, number: r.number, amount: r.total, currency: r.currency, ts: new Date().toISOString() });
    }
    s.lastStatus[r.id] = r.status;
  }
  persist();
}

/** Cached for a few seconds so UI polling does not hammer PayPal. `fresh` bypasses the cache. */
export async function book(fresh = false): Promise<Book> {
  if (!fresh && g.__ppgBook && Date.now() - g.__ppgBook.fetchedAt < 4000) return g.__ppgBook;
  if (!g.__ppgBookP) {
    g.__ppgBookP = load()
      .then((b) => (g.__ppgBook = b))
      .finally(() => (g.__ppgBookP = null));
  }
  return g.__ppgBookP;
}

export function invalidateBook() {
  if (g.__ppgBook) g.__ppgBook.fetchedAt = 0;
}
