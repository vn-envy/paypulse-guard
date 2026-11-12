// Minimal PayPal sandbox client for the CLI scripts. Sandbox host only.
const BASE = "https://api-m.sandbox.paypal.com";
let token;

export function requireCreds() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_SECRET) {
    console.error("Set PAYPAL_CLIENT_ID and PAYPAL_SECRET in .env.local first (see .env.example).");
    process.exit(1);
  }
}

export async function pp(method, path, body) {
  if (!token) {
    const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString("base64");
    const r = await fetch(`${BASE}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, data: d, debugId: r.headers.get("paypal-debug-id"), scope: "" };
    token = d;
  }
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", ...(method !== "GET" ? { "PayPal-Request-Id": crypto.randomUUID() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, data, debugId: r.headers.get("paypal-debug-id"), scope: token.scope ?? "" };
}

export const idFrom = (d) => d?.id ?? String(d?.href ?? "").split("/").pop();
export const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
export const explain = (r) => `${r.status} ${r.data?.name ?? ""} ${r.data?.message ?? ""} ${r.data?.details?.map((x) => `${x.field ?? ""} ${x.issue ?? ""} ${x.description ?? ""}`).join("; ") ?? ""} (debug ${r.debugId})`.replace(/\s+/g, " ");

export function draft({ business, email, reference, value, invoiceDate, note }) {
  return {
    detail: {
      currency_code: "USD",
      reference,
      note: note ?? "Thank you for your business.",
      ...(invoiceDate ? { invoice_date: invoiceDate } : {}),
      payment_term: { term_type: "NET_10" },
    },
    primary_recipients: [{ billing_info: { business_name: business, email_address: email } }],
    items: [{ name: reference, quantity: "1", unit_amount: { currency_code: "USD", value: value.toFixed(2) } }],
  };
}
