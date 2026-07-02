// Turn a completed Stripe session into a Printify order (idempotently).
import type { Env } from "./types";

const PRINTIFY_API = "https://api.printify.com/v1";
const UA = "nightlybuild-store/1.0 (+https://nightlybuild.courtrightco.com)";

interface CartTuple extends Array<string | number> {} // [productId, variantId, qty]

// Called from the checkout.session.completed webhook.
export async function fulfillOrder(env: Env, session: any): Promise<void> {
  const sessionId: string = session.id;
  const idemKey = `order:${sessionId}`;

  // Idempotency: Stripe retries webhooks. Skip if we've already handled this session.
  const seen = await env.CATALOG_KV.get(idemKey);
  if (seen) return;

  const cart = parseCart(session?.metadata?.cart);
  if (!cart.length) {
    console.warn(`No cart metadata on session ${sessionId}; nothing to fulfill.`);
    await env.CATALOG_KV.put(idemKey, "no-cart", { expirationTtl: 60 * 60 * 24 * 30 });
    return;
  }

  const address = extractAddress(session);
  if (!address) {
    console.error(`Missing shipping address on session ${sessionId}; cannot create Printify order.`);
    return; // do NOT mark done — allow a manual retry
  }

  const line_items = cart.map(([productId, variantId, quantity]) => ({
    product_id: String(productId),
    variant_id: Number(variantId),
    quantity: Number(quantity),
  }));

  const body = {
    external_id: sessionId, // idempotency handle on Printify's side too
    label: `NB ${sessionId.slice(-8)}`,
    line_items,
    shipping_method: 1, // standard
    is_printify_express: false,
    send_shipping_notification: false,
    address_to: address,
  };

  const res = await fetch(`${PRINTIFY_API}/shops/${env.PRINTIFY_SHOP_ID}/orders.json`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.PRINTIFY_API_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    // 400 with "external_id already exists" means another retry beat us — treat as done.
    if (res.status === 400 && /external_id/i.test(text) && /exist/i.test(text)) {
      await env.CATALOG_KV.put(idemKey, "dup", { expirationTtl: 60 * 60 * 24 * 30 });
      return;
    }
    console.error(`Printify order failed (${res.status}) for ${sessionId}: ${text.slice(0, 400)}`);
    throw new Error(`Printify order creation failed: ${res.status}`);
  }

  // NOTE: We intentionally do NOT call the order "send to production" endpoint.
  // If the shop's order approval is Manual, orders wait for Dillon's approval.
  const created: any = safeJson(text);
  const printifyOrderId = created?.id ?? "unknown";
  await env.CATALOG_KV.put(idemKey, printifyOrderId, { expirationTtl: 60 * 60 * 24 * 30 });
  console.log(`Printify order ${printifyOrderId} created for Stripe session ${sessionId}.`);
}

function parseCart(raw: unknown): CartTuple[] {
  if (typeof raw !== "string") return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (t) => Array.isArray(t) && t.length >= 3 && Number(t[1]) > 0 && Number(t[2]) > 0
    );
  } catch {
    return [];
  }
}

function extractAddress(session: any): Record<string, string> | null {
  const shipping = session.shipping_details ?? session.collected_information?.shipping_details;
  const addr = shipping?.address ?? session.customer_details?.address;
  if (!addr || !addr.line1 || !addr.country) return null;

  const fullName: string =
    shipping?.name ?? session.customer_details?.name ?? "Nightly Build Customer";
  const [first, ...rest] = fullName.trim().split(/\s+/);
  const last = rest.join(" ") || first;

  return {
    first_name: first || "Nightly",
    last_name: last || "Build",
    email: session.customer_details?.email ?? "",
    phone: session.customer_details?.phone ?? "",
    country: addr.country, // ISO2
    region: addr.state ?? "",
    address1: addr.line1,
    address2: addr.line2 ?? "",
    city: addr.city ?? "",
    zip: addr.postal_code ?? "",
  };
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
