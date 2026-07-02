// Nightly Build storefront Worker: static assets + /api/* (Printify + Stripe).
import type { Env, NBProduct } from "./types";
import { getCatalog, findProduct, findVariant } from "./printify";
import { createCheckoutSession, verifyWebhook, retrieveSession, type CheckoutLine } from "./stripe";
import { fulfillOrder } from "./fulfillment";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname.startsWith("/api/")) {
        return await handleApi(pathname, request, env, ctx, url);
      }

      // /p/:handle has no static file — serve the product template shell.
      // Fetch the extensionless path so asset canonicalization returns 200
      // (requesting /product.html would 307-redirect to /product).
      if (pathname === "/p" || pathname.startsWith("/p/")) {
        const res = await env.ASSETS.fetch(new Request(new URL("/product", url), request));
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        });
      }

      // Everything else: static assets (html_handling maps /shop -> /shop.html, etc.)
      return env.ASSETS.fetch(request);
    } catch (err: any) {
      console.error("Unhandled error:", err?.stack ?? err);
      if (pathname.startsWith("/api/")) {
        return json({ error: "internal_error", message: String(err?.message ?? err) }, 500);
      }
      return new Response("Something broke while we were building. Try again.", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

async function handleApi(
  pathname: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL
): Promise<Response> {
  switch (pathname) {
    case "/api/catalog":
      return apiCatalog(env, url);
    case "/api/product":
      return apiProduct(env, url);
    case "/api/suggest":
      return apiSuggest(env, url);
    case "/api/config":
      return json({ publishableKey: env.STRIPE_PUBLISHABLE_KEY });
    case "/api/session":
      return apiSession(env, url);
    case "/api/checkout":
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      return apiCheckout(env, request);
    case "/api/stripe-webhook":
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      return apiWebhook(env, ctx, request);
    default:
      return json({ error: "not_found" }, 404);
  }
}

// GET /api/catalog?refresh=1  -> full normalized catalog (enabled variants only)
async function apiCatalog(env: Env, url: URL): Promise<Response> {
  const refresh = url.searchParams.get("refresh") === "1";
  const catalog = await getCatalog(env, refresh);
  const products = catalog.products.map((p) => publicProduct(p));
  return json(
    { updatedAt: catalog.updatedAt, count: products.length, products },
    200,
    { "Cache-Control": "public, max-age=120" }
  );
}

// GET /api/product?handle=... (or ?id=...)
async function apiProduct(env: Env, url: URL): Promise<Response> {
  const key = url.searchParams.get("handle") ?? url.searchParams.get("id") ?? "";
  if (!key) return json({ error: "missing_handle" }, 400);
  const catalog = await getCatalog(env);
  const product = findProduct(catalog, key);
  if (!product) return json({ error: "not_found" }, 404);
  return json(
    { product: publicProduct(product, true) },
    200,
    { "Cache-Control": "public, max-age=120" }
  );
}

// GET /api/suggest?product=ID  -> up to 6 related products.
// v1 logic: same product type OR a shared tag/theme, shuffled, capped.
async function apiSuggest(env: Env, url: URL): Promise<Response> {
  const key = url.searchParams.get("product") ?? "";
  const catalog = await getCatalog(env);
  const base = findProduct(catalog, key);
  const themeTags = new Set(
    (base?.tags ?? [])
      .map((t) => t.toLowerCase())
      .filter((t) => /founder|builder|dev|ship|build|terminal|night/.test(t))
  );

  const scored = catalog.products
    .filter((p) => p.id !== base?.id)
    .map((p) => {
      let score = 0;
      if (base && p.productType === base.productType) score += 2;
      for (const t of p.tags) if (themeTags.has(t.toLowerCase())) score += 3;
      return { p, score };
    })
    .filter((x) => (base ? x.score > 0 : true));

  // Stable-ish shuffle without Math.random (not available at module top; fine here
  // but we keep it deterministic-per-request by seeding off the base id length).
  const seed = (base?.id.length ?? 7) * 31 + catalog.products.length;
  const shuffled = seededShuffle(scored, seed).sort((a, b) => b.score - a.score);
  const picks = shuffled.slice(0, 6).map((x) => publicProduct(x.p));
  return json({ products: picks }, 200, { "Cache-Control": "public, max-age=120" });
}

// GET /api/session?id=cs_...  -> safe summary for the success page.
async function apiSession(env: Env, url: URL): Promise<Response> {
  const id = url.searchParams.get("id") ?? "";
  if (!id.startsWith("cs_")) return json({ error: "bad_id" }, 400);
  try {
    const s = await retrieveSession(env, id);
    const shipping = s.shipping_details ?? s.collected_information?.shipping_details;
    return json({
      order: {
        total: s.amount_total ?? null,
        currency: s.currency ?? "usd",
        email: s.customer_details?.email ?? null,
        shippingName: shipping?.name ?? s.customer_details?.name ?? null,
        paid: s.payment_status === "paid",
      },
    });
  } catch {
    return json({ error: "not_found" }, 404);
  }
}

// POST /api/checkout  { items: [{ variantId, quantity }] }
async function apiCheckout(env: Env, request: Request): Promise<Response> {
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const items: any[] = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) return json({ error: "empty_cart" }, 400);

  // Always re-price from the live catalog — never trust client prices.
  const catalog = await getCatalog(env);
  const lines: CheckoutLine[] = [];
  for (const item of items) {
    const variantId = Number(item?.variantId);
    const quantity = Math.max(1, Math.min(20, Number(item?.quantity) || 1));
    if (!Number.isFinite(variantId)) continue;

    // Find which product owns this variant.
    let owner: NBProduct | undefined;
    let variant;
    for (const p of catalog.products) {
      const v = findVariant(p, variantId);
      if (v) {
        owner = p;
        variant = v;
        break;
      }
    }
    if (!owner || !variant || !variant.is_enabled) {
      return json({ error: "invalid_variant", variantId }, 400);
    }

    const namePieces = [owner.title];
    if (variant.color) namePieces.push(variant.color);
    if (variant.size) namePieces.push(variant.size);
    lines.push({
      productId: owner.id,
      variantId,
      quantity,
      unitAmount: variant.price, // server-trusted cents
      name: namePieces.join(" · "),
      image: variant.image ?? owner.images[0] ?? null,
    });
  }

  if (!lines.length) return json({ error: "no_valid_items" }, 400);

  const session = await createCheckoutSession(env, lines);
  return json({ url: session.url, id: session.id });
}

// POST /api/stripe-webhook  -> verify signature, create Printify order.
async function apiWebhook(env: Env, ctx: ExecutionContext, request: Request): Promise<Response> {
  const payload = await request.text();
  const sig = request.headers.get("stripe-signature");
  const event = await verifyWebhook(payload, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!event) return json({ error: "invalid_signature" }, 400);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    // Ensure we have full shipping details before fulfilling.
    ctx.waitUntil(
      (async () => {
        try {
          const full = await retrieveSession(env, session.id);
          await fulfillOrder(env, full);
        } catch (err) {
          console.error("Fulfillment error:", err);
        }
      })()
    );
  }
  // Always 200 quickly so Stripe doesn't retry a slow-but-successful handler.
  return json({ received: true });
}

// ---- helpers ----

// Public projection. Full=true keeps every variant for the product page;
// list views drop per-variant arrays to stay lean.
function publicProduct(p: NBProduct, full = false) {
  const base = {
    id: p.id,
    handle: p.handle,
    title: p.title,
    tags: p.tags,
    productType: p.productType,
    drop: p.drop,
    priceMin: p.priceMin,
    priceMax: p.priceMax,
    colors: p.colors,
    sizes: p.sizes,
    image: p.images[0] ?? null,
    images: full ? p.images : p.images.slice(0, 1),
  };
  if (!full) return base;
  return {
    ...base,
    description: p.description,
    variants: p.variants
      .filter((v) => v.is_enabled)
      .map((v) => ({
        id: v.id,
        color: v.color,
        colorHex: v.colorHex,
        size: v.size,
        price: v.price,
        image: v.image,
      })),
  };
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}
