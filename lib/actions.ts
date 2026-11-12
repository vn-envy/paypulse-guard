import { PayPalError, pp } from "./paypal";
import type { Action, PayPalCall } from "./types";

type Out = { ok: boolean; calls: PayPalCall[]; note: string; touchedInvoiceIds: string[] };

/** PayPal write implementations. Only lib/guard.ts calls this, after a signature check. */
export async function executeOnPayPal(action: Action, requestId: string): Promise<Out> {
  const calls: PayPalCall[] = [];
  const touched: string[] = [];
  let step = 0;

  const call = async (method: string, path: string, body?: unknown) => {
    const rid = `${requestId.slice(0, -2)}${String(step++).padStart(2, "0")}`;
    try {
      const r = await pp<any>(path, { method, body, requestId: rid });
      calls.push({ method, path, status: r.status, requestId: rid, debugId: r.debugId });
      return r.data;
    } catch (e) {
      if (e instanceof PayPalError) calls.push({ method, path, status: e.status, requestId: rid, debugId: e.debugId });
      throw e;
    }
  };

  try {
    if (action.type === "send_reminder") {
      const a = action as Extract<Action, { type: "send_reminder" }>;
      await call("POST", `/v2/invoicing/invoices/${a.invoiceId}/remind`, {
        subject: a.subject,
        note: a.note,
        send_to_invoicer: true,
        send_to_recipient: true,
      });
      touched.push(a.invoiceId);
      return { ok: true, calls, note: "Reminder sent by PayPal to the client.", touchedInvoiceIds: touched };
    }

    if (action.type === "offer_settlement") {
      const a = action as Extract<Action, { type: "offer_settlement" }>;
      const original = (await pp<any>(`/v2/invoicing/invoices/${a.invoiceId}`)).data;
      const cur = original.detail?.currency_code ?? original.amount?.currency_code ?? "USD";
      const due = original.due_amount?.value ?? original.amount?.value;
      const items =
        Array.isArray(original.items) && original.items.length
          ? original.items.map((it: any) => ({ name: it.name, description: it.description, quantity: it.quantity, unit_amount: it.unit_amount }))
          : [{ name: `Balance of invoice ${original.detail?.invoice_number ?? a.invoiceId}`, quantity: "1", unit_amount: { currency_code: cur, value: due } }];
      const draft = {
        detail: {
          currency_code: cur,
          reference: original.detail?.reference,
          note: a.note,
          memo: `Settlement offer replacing ${original.detail?.invoice_number ?? a.invoiceId}`,
          payment_term: { term_type: "DUE_ON_RECEIPT" },
        },
        invoicer: original.invoicer,
        primary_recipients: (original.primary_recipients ?? []).map((r: any) => ({ billing_info: r.billing_info })),
        items,
        amount: { breakdown: { discount: { invoice_discount: { percent: String(a.discountPct) } } } },
      };
      const created = await call("POST", "/v2/invoicing/invoices", draft);
      const newId: string | undefined = created?.id ?? String(created?.href ?? "").split("/").pop();
      if (!newId) throw new Error("PayPal did not return the new invoice id.");
      await call("POST", `/v2/invoicing/invoices/${newId}/send`, { send_to_recipient: true, send_to_invoicer: true });
      touched.push(newId);
      try {
        await call("POST", `/v2/invoicing/invoices/${a.invoiceId}/cancel`, {
          subject: "Invoice replaced",
          note: "This invoice has been replaced by a discounted settlement invoice.",
          send_to_recipient: false,
          send_to_invoicer: false,
        });
      } catch (e: any) {
        return {
          ok: true,
          calls,
          note: `Settlement invoice ${newId} sent at ${a.discountPct}% off, but the original could not be cancelled (${e.message}). Cancel it by hand.`,
          touchedInvoiceIds: touched,
        };
      }
      return { ok: true, calls, note: `Settlement invoice sent at ${a.discountPct}% off. Original cancelled.`, touchedInvoiceIds: touched };
    }

    if (action.type === "accept_dispute_claim") {
      const a = action as Extract<Action, { type: "accept_dispute_claim" }>;
      await call("POST", `/v1/customer/disputes/${a.disputeId}/accept-claim`, { note: a.note });
      return { ok: true, calls, note: "Claim accepted. PayPal refunds the buyer.", touchedInvoiceIds: touched };
    }

    return { ok: false, calls, note: `No executor for ${action.type}.`, touchedInvoiceIds: touched };
  } catch (e: any) {
    return { ok: false, calls, note: e.message ?? String(e), touchedInvoiceIds: touched };
  }
}
