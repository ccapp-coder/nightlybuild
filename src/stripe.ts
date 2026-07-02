// Minimal Stripe REST helpers (no SDK) for Workers.
import type { Env } from "./types";

const STRIPE_API = "https://api.stripe.com/v1";

export interface CheckoutLine {
  productId: string;
  variantId: number;
  quantity: number;
  unitAmount: number; // cents, server-trusted
  name: string;
  image?: string | null;
}

// Create a Stripe Checkout Session and return its hosted URL.
export async function createCheckoutSession(
  env: Env,
  lines: CheckoutLine[]
): Promise<{ id: string; url: string }> {
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", `${env.SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", `${env.SITE_URL}/cart`);
  form.set("billing_address_collection", "auto");
  form.set("phone_number_collection[enabled]", "true");

  // Ship to US + common English-speaking markets. Adjust as fulfillment allows.
  for (const c of ["US", "CA", "GB", "AU", "NZ", "IE"]) {
    form.append("shipping_address_collection[allowed_countries][]", c);
  }

  lines.forEach((line, i) => {
    form.set(`line_items[${i}][quantity]`, String(line.quantity));
    form.set(`line_items[${i}][price_data][currency]`, "usd");
    form.set(`line_items[${i}][price_data][unit_amount]`, String(line.unitAmount));
    form.set(`line_items[${i}][price_data][product_data][name]`, line.name);
    if (line.image) {
      form.set(`line_items[${i}][price_data][product_data][images][0]`, line.image);
    }
  });

  // Compact cart snapshot for fulfillment: [[productId, variantId, qty], ...]
  // Kept under Stripe's 500-char metadata limit for typical carts.
  const cart = lines.map((l) => [l.productId, l.variantId, l.quantity]);
  form.set("metadata[cart]", JSON.stringify(cart).slice(0, 490));

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const json: any = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe session failed (${res.status}): ${json?.error?.message ?? "unknown"}`);
  }
  return { id: json.id, url: json.url };
}

// Retrieve a session (with shipping details) for the success page / webhook.
export async function retrieveSession(env: Env, sessionId: string): Promise<any> {
  const res = await fetch(
    `${STRIPE_API}/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );
  const json: any = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe retrieve failed (${res.status}): ${json?.error?.message ?? "unknown"}`);
  }
  return json;
}

// Verify a Stripe webhook signature (t + v1 scheme) using Web Crypto.
// Returns the parsed event on success, or null on any verification failure.
export async function verifyWebhook(
  payload: string,
  sigHeader: string | null,
  secret: string,
  toleranceSeconds = 300,
  nowMs = Date.now()
): Promise<any | null> {
  if (!sigHeader) return null;
  let t = "";
  const v1: string[] = [];
  for (const part of sigHeader.split(",")) {
    const [k, val] = part.split("=");
    if (k === "t") t = val;
    else if (k === "v1") v1.push(val);
  }
  if (!t || v1.length === 0) return null;

  // Reject stale timestamps (replay protection).
  const ts = Number(t);
  if (!Number.isFinite(ts)) return null;
  if (Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return null;

  const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
  const ok = v1.some((sig) => timingSafeEqual(sig, expected));
  if (!ok) return null;

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
