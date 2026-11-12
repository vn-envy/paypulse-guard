import crypto from "node:crypto";
import { emulate } from "./emulator";

/**
 * One transport for every PayPal call in the app.
 * With credentials: PayPal sandbox REST. Without: the in-process emulator in lib/emulator.ts.
 * The host is hardcoded to the sandbox. This build cannot talk to live PayPal.
 */
const BASE = "https://api-m.sandbox.paypal.com";

export function paypalMode(): "sandbox" | "emulator" {
  return process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET ? "sandbox" : "emulator";
}

export class PayPalError extends Error {
  constructor(
    public status: number,
    public method: string,
    public path: string,
    public body: any,
    public debugId: string | null,
    public requestId: string,
  ) {
    const name = body?.name ? `${body.name}: ` : "";
    const issue = body?.details?.[0]?.issue ? ` (${body.details[0].issue})` : "";
    super(`PayPal ${method} ${path} -> ${status} ${name}${body?.message ?? ""}${issue}`.trim());
  }
}

let token: { value: string; exp: number } | null = null;

async function accessToken(force = false): Promise<string> {
  if (!force && token && token.exp > Date.now() + 60_000) return token.value;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new PayPalError(res.status, "POST", "/v1/oauth2/token", { message: data.error_description ?? "OAuth failed" }, res.headers.get("paypal-debug-id"), "-");
  }
  token = { value: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return token.value;
}

export type PPResult<T> = { status: number; data: T; requestId: string; debugId: string | null; method: string; path: string };

export async function pp<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; requestId?: string } = {},
): Promise<PPResult<T>> {
  const method = opts.method ?? "GET";
  const requestId = opts.requestId ?? crypto.randomUUID();

  if (paypalMode() === "emulator") {
    const r = emulate(method, path, opts.body, requestId);
    if (r.status >= 400) throw new PayPalError(r.status, method, path, r.data, r.debugId, requestId);
    return { status: r.status, data: r.data as T, requestId, debugId: r.debugId, method, path };
  }

  let tok = await accessToken();
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
    // Same PayPal-Request-Id on every retry, so a retried write can never execute twice.
    if (method !== "GET") headers["PayPal-Request-Id"] = requestId;
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: "no-store",
    });
    if (res.status === 401 && attempt === 0) {
      tok = await accessToken(true);
      continue;
    }
    if ((res.status >= 500 || res.status === 429) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text.slice(0, 300) };
    }
    const debugId = res.headers.get("paypal-debug-id");
    if (!res.ok) throw new PayPalError(res.status, method, path, data, debugId, requestId);
    return { status: res.status, data: data as T, requestId, debugId, method, path };
  }
}
