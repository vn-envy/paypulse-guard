// Creates and sends three demo invoices in your PayPal sandbox:
// two overdue (back-dated) and one not yet due. Safe to run more than once; it adds new invoices each time.
import { day, draft, explain, idFrom, pp, requireCreds } from "./_pp.mjs";

requireCreds();
const buyer = process.env.PAYPAL_BUYER_EMAIL;
if (!buyer) {
  console.error("Set PAYPAL_BUYER_EMAIL in .env.local to the email of a sandbox *personal* account\n(developer.paypal.com > Testing Tools > Sandbox Accounts). The buyer pays the invoices in the demo.");
  process.exit(1);
}

const plan = [
  { business: "Acme Cloud Corp", reference: "M2: Production API rollout", value: 4800, backdate: -24 }, // due 14 days ago
  { business: "Northstar Retail", reference: "M3: Vector search sync", value: 2150, backdate: -16 }, //   due 6 days ago
  { business: "Halden Studio", reference: "M1: Discovery sprint", value: 1200, backdate: -1 }, //        due in 9 days
];

let backdatingWorks = true;
for (const p of plan) {
  let r = await pp("POST", "/v2/invoicing/invoices", draft({ ...p, email: buyer, invoiceDate: day(p.backdate) }));
  if (!r.ok && r.status < 500 && r.status !== 401 && r.status !== 403) {
    console.warn(`  back-dated create refused: ${explain(r)}\n  retrying with today's date`);
    backdatingWorks = false;
    r = await pp("POST", "/v2/invoicing/invoices", draft({ ...p, email: buyer }));
  }
  if (!r.ok) {
    console.error(`FAILED to create "${p.reference}": ${explain(r)}`);
    if (r.status === 403 || r.status === 401) console.error("  Enable the Invoicing feature on your sandbox app, save, wait a minute, and retry.");
    process.exit(1);
  }
  const id = idFrom(r.data);
  const sent = await pp("POST", `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: true, send_to_invoicer: false });
  console.log(`${sent.ok ? "sent  " : "DRAFT "} ${id}  ${p.business}  USD ${p.value}  ${sent.ok ? "" : explain(sent)}`);
}
// Payment history: three older invoices, sent and then recorded as paid a few days late or on time.
// The app computes each client's usual lateness from these, and the agent compares today's delay against it.
const history = [
  { business: "Acme Cloud Corp", reference: "M1: Architecture review", value: 3600, backdate: -62, paidLate: 2 },
  { business: "Acme Cloud Corp", reference: "Discovery workshop", value: 1500, backdate: -98, paidLate: 4 },
  { business: "Northstar Retail", reference: "M2: Catalogue ingestion", value: 2150, backdate: -57, paidLate: 0 },
];
if (backdatingWorks) {
  for (const h of history) {
    const c = await pp("POST", "/v2/invoicing/invoices", draft({ ...h, email: buyer, invoiceDate: day(h.backdate) }));
    const id = idFrom(c.data);
    if (!c.ok || !id) { console.warn(`history skipped (${h.reference}): ${explain(c)}`); continue; }
    const sent = await pp("POST", `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: false, send_to_invoicer: false });
    const paid = sent.ok
      ? await pp("POST", `/v2/invoicing/invoices/${id}/payments`, { method: "BANK_TRANSFER", payment_date: day(h.backdate + 10 + h.paidLate), amount: { currency_code: "USD", value: h.value.toFixed(2) } })
      : sent;
    console.log(`${paid.ok ? "paid  " : "FAILED"} ${id}  ${h.business}  USD ${h.value}  history${paid.ok ? "" : `  ${explain(paid)}`}`);
  }
} else {
  console.warn("Skipping payment history because back-dating was refused. Clients will show 'no payment history yet'.");
}

if (!backdatingWorks) {
  console.warn("\nPayPal refused back-dated invoices, so nothing will show as overdue yet.\nThe agent will correctly leave them alone. Tell me the error above and the seed can be adjusted.");
}
console.log("\nDone. Start the app with `npm run dev` and open http://localhost:3000");
