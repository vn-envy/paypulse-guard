import { NextResponse } from "next/server";
import { record } from "@/lib/ledger";
import { paypalMode, pp } from "@/lib/paypal";
import { book } from "@/lib/receivables";

export const dynamic = "force-dynamic";

const g = globalThis as unknown as { __ppgEvents?: Set<string> };

/**
 * PayPal webhook receiver. An event is trusted only after PayPal itself confirms the signature.
 * Unverifiable events are refused, never processed. On a verified event we re-read PayPal,
 * so the event is a trigger and PayPal's API stays the source of truth.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Body is not JSON." }, { status: 400 });
  }
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  const h = (n: string) => req.headers.get(n);
  if (paypalMode() !== "sandbox" || !webhookId || !h("paypal-transmission-id") || !h("paypal-transmission-sig")) {
    record({ actor: "guard", event: "webhook_refused", target: String(event?.event_type ?? "unknown"), detail: "Webhook could not be verified (missing signature headers or PAYPAL_WEBHOOK_ID).", outcome: "denied" });
    return NextResponse.json({ error: "Webhook cannot be verified." }, { status: 400 });
  }
  let status = "FAILURE";
  try {
    const v = await pp<{ verification_status: string }>("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: {
        auth_algo: h("paypal-auth-algo"),
        cert_url: h("paypal-cert-url"),
        transmission_id: h("paypal-transmission-id"),
        transmission_sig: h("paypal-transmission-sig"),
        transmission_time: h("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: event,
      },
    });
    status = v.data.verification_status;
  } catch (e: any) {
    // 5xx makes PayPal retry later instead of dropping the event.
    return NextResponse.json({ error: e.message }, { status: 503 });
  }
  if (status !== "SUCCESS") {
    record({ actor: "guard", event: "webhook_refused", target: String(event.event_type), detail: "PayPal reported the webhook signature as invalid.", outcome: "denied" });
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }
  const seen = (g.__ppgEvents ??= new Set());
  if (!seen.has(event.id)) {
    seen.add(event.id);
    record({ actor: "paypal", event: "webhook_verified", target: String(event.event_type), detail: `Event ${event.id} verified by PayPal. Resource ${event.resource?.id ?? event.resource?.invoice?.id ?? event.resource?.dispute_id ?? "n/a"}.`, outcome: "ok" });
    await book(true).catch(() => null);
  }
  return NextResponse.json({ received: true });
}
