// Checks every PayPal endpoint PayPulse Guard depends on against YOUR sandbox, one by one.
//   npm run verify:paypal              read-only checks
//   npm run verify:paypal -- --writes  also creates one throwaway invoice and sends, reminds, replaces and cancels it
import { day, draft, explain, idFrom, pp, requireCreds } from "./_pp.mjs";

requireCreds();
const writes = process.argv.includes("--writes");
let failed = 0;
const line = (ok, name, r, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${explain(r)}`}${extra ? `\n      ${extra}` : ""}`);
};

let r = await pp("GET", "/v2/invoicing/invoices?page=1&page_size=100&total_required=true&fields=all");
if (r.status === 401 && !r.scope) {
  console.log(`FAIL  OAuth token\n      ${explain(r)}\n      Check PAYPAL_CLIENT_ID / PAYPAL_SECRET are the *sandbox* credentials.`);
  process.exit(1);
}
console.log("PASS  OAuth token (client credentials)");
const items = r.data.items ?? [];
const sample = items[0];
line(r.ok, `List invoices (${items.length} found)`, r, r.ok && sample
  ? `sample: status=${sample.status} number=${sample.detail?.invoice_number} due_date=${sample.detail?.payment_term?.due_date} due_amount=${sample.due_amount?.value} reference=${sample.detail?.reference} pay_url=${sample.detail?.metadata?.recipient_view_url ? "yes" : "no"}`
  : r.ok ? "no invoices yet: run `npm run seed`" : "Enable Invoicing on the sandbox app.");

r = await pp("GET", "/v1/customer/disputes?page_size=20");
line(r.ok, `List disputes (${r.data.items?.length ?? 0} found)`, r, r.ok ? "" : "Disputes are optional for the demo. The app shows the error and carries on.");

if (process.env.PAYPAL_WEBHOOK_ID) {
  r = await pp("GET", `/v1/notifications/webhooks/${process.env.PAYPAL_WEBHOOK_ID}`);
  line(r.ok, "Webhook ID exists", r, r.ok ? `url=${r.data.url} events=${(r.data.event_types ?? []).map((e) => e.name).join(",")}` : "");
} else console.log("SKIP  Webhook (PAYPAL_WEBHOOK_ID not set; the app polls PayPal instead)");

if (writes) {
  const email = process.env.PAYPAL_BUYER_EMAIL ?? "sb-verify@personal.example.com";
  r = await pp("POST", "/v2/invoicing/invoices", draft({ business: "Verify Co", email, reference: "PayPulse verify", value: 10, invoiceDate: day(-20) }));
  line(r.ok, "Create back-dated draft invoice", r);
  const id = idFrom(r.data);
  if (r.ok && id) {
    r = await pp("POST", `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: true, send_to_invoicer: false });
    line(r.ok, "Send invoice", r);
    r = await pp("GET", `/v2/invoicing/invoices/${id}`);
    line(r.ok && !!r.data.detail?.payment_term?.due_date, "Read invoice back with a due date", r, `status=${r.data.status} due_date=${r.data.detail?.payment_term?.due_date} items=${r.data.items?.length ?? 0}`);
    const original = r.data;
    r = await pp("POST", `/v2/invoicing/invoices/${id}/remind`, { subject: "Verify reminder", note: "Verify reminder note.", send_to_invoicer: true, send_to_recipient: true });
    line(r.ok, "Send reminder", r);
    // Same body the settlement action builds.
    r = await pp("POST", "/v2/invoicing/invoices", {
      detail: { currency_code: "USD", reference: original.detail?.reference, note: "Settlement verify", memo: "Settlement verify", payment_term: { term_type: "DUE_ON_RECEIPT" } },
      invoicer: original.invoicer,
      primary_recipients: (original.primary_recipients ?? []).map((x) => ({ billing_info: x.billing_info })),
      items: (original.items ?? []).map((it) => ({ name: it.name, description: it.description, quantity: it.quantity, unit_amount: it.unit_amount })),
      amount: { breakdown: { discount: { invoice_discount: { percent: "5" } } } },
    });
    line(r.ok, "Create discounted replacement (settlement body)", r);
    const newId = idFrom(r.data);
    if (r.ok && newId) {
      r = await pp("GET", `/v2/invoicing/invoices/${newId}`);
      line(r.ok && Number(r.data.amount?.value) === 9.5, "Replacement total is 5% lower", r, `amount=${r.data.amount?.value}`);
      r = await pp("POST", `/v2/invoicing/invoices/${newId}/cancel`, { send_to_recipient: false, send_to_invoicer: false }).then((x) => (x.ok ? x : pp("DELETE", `/v2/invoicing/invoices/${newId}`)));
      line(r.ok, "Clean up replacement draft", r);
    }
    r = await pp("POST", `/v2/invoicing/invoices/${id}/cancel`, { subject: "Invoice replaced", note: "Verify cancel.", send_to_recipient: false, send_to_invoicer: false });
    line(r.ok, "Cancel sent invoice", r);
  }
  // Payment history path: record an external payment with a past date, then read the date back.
  r = await pp("POST", "/v2/invoicing/invoices", draft({ business: "Verify Co", email, reference: "PayPulse verify history", value: 10, invoiceDate: day(-40) }));
  const hid = idFrom(r.data);
  if (r.ok && hid) {
    await pp("POST", `/v2/invoicing/invoices/${hid}/send`, { send_to_recipient: false, send_to_invoicer: false });
    r = await pp("POST", `/v2/invoicing/invoices/${hid}/payments`, { method: "BANK_TRANSFER", payment_date: day(-27), amount: { currency_code: "USD", value: "10.00" } });
    line(r.ok, "Record a back-dated payment", r);
    r = await pp("GET", `/v2/invoicing/invoices/${hid}`);
    const pd = r.data.payments?.transactions?.[0]?.payment_date;
    line(r.ok && !!pd, "Read payment date back (client history)", r, `status=${r.data.status} payment_date=${pd}`);
  }
}

console.log(failed ? `\n${failed} check(s) failed. Paste this output back and they can be fixed.` : `\nAll checks passed.${writes ? "" : " Run again with `-- --writes` to check the write endpoints."}`);
process.exit(failed ? 1 : 0);
