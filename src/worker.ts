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

      // /p/:handle has no static file — serve the product template shell with
      // this product's metadata written into the head.
      //
      // It used to serve the bare template for ANY /p/* path, which meant every
      // product URL returned byte-identical HTML: the same "nightly build"
      // title, the same generic description, no canonical, and a 200 even for
      // slugs that do not exist. To a crawler that is one page duplicated across
      // unlimited URLs, so nothing on this store could rank on its own terms.
      if (pathname === "/p" || pathname.startsWith("/p/")) {
        return await serveProductPage(pathname, request, env, url);
      }

      // Generated here rather than served from public/sitemap.xml, which listed
      // six static pages and not one product. The shop grid is rendered
      // client-side, so there was no crawlable path to any product at all: not
      // from the sitemap, not from /shop. This is the only discovery route.
      if (pathname === "/sitemap.xml") {
        return await serveSitemap(env);
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

const SITE_ORIGIN = "https://nightlybuild.courtrightco.com";

/** Escapes for an HTML attribute value or text node. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Google renders ~155 characters of a description; cut on a word boundary. */
function clamp(s: string, max = 155): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(" ")).trimEnd() + "…";
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * A product page with its own title, description, canonical, card and Product
 * schema, streamed through HTMLRewriter over the shared template.
 *
 * An unknown handle gets a real 404. Returning 200 for every string after /p/
 * is what let this store present unlimited near-identical pages, which spends
 * crawl budget and invites Google to collapse or drop the real ones.
 */
async function serveProductPage(
  pathname: string,
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const handle = decodeURIComponent(pathname.slice("/p/".length)).replace(/\/+$/, "");

  let product: NBProduct | undefined;
  if (handle) {
    // A catalog fetch that fails must not turn a real product page into a 404 —
    // that would deindex the whole store on one bad upstream response. Fall
    // through to the unmodified template instead: stale metadata beats a lie
    // about the page not existing.
    try {
      const catalog = await getCatalog(env);
      product = findProduct(catalog, handle);
    } catch (err: any) {
      console.error("catalog lookup failed for", handle, err?.message ?? err);
      const res = await env.ASSETS.fetch(new Request(new URL("/product", url), request));
      return new Response(res.body, { status: res.status, headers: res.headers });
    }
  }

  if (!product) return notFoundPage(handle);

  const canonical = `${SITE_ORIGIN}/p/${encodeURIComponent(product.handle)}`;
  const title = `${product.title} — nightly build`;
  const description = clamp(
    product.description || `${product.productType} from Nightly Build, printed on demand.`
  );
  const image = product.images[0] ?? `${SITE_ORIGIN}/img/og.png`;

  const schema = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    description,
    image: product.images.length ? product.images : [`${SITE_ORIGIN}/img/og.png`],
    sku: product.handle,
    brand: { "@type": "Brand", name: "Nightly Build" },
    offers: {
      // AggregateOffer because a product has size and colour variants spanning
      // a price range; a single Offer would have to invent one price.
      "@type": "AggregateOffer",
      url: canonical,
      priceCurrency: "USD",
      lowPrice: money(product.priceMin),
      highPrice: money(product.priceMax),
      offerCount: product.variants.length,
      availability: "https://schema.org/InStock",
    },
  };

  const res = await env.ASSETS.fetch(new Request(new URL("/product", url), request));
  if (!res.ok) return new Response(res.body, { status: res.status, headers: res.headers });

  const rewritten = new HTMLRewriter()
    .on("title", {
      element(el) {
        el.setInnerContent(title);
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        el.setAttribute("content", description);
      },
    })
    .on('meta[property="og:image"]', {
      element(el) {
        el.setAttribute("content", image);
      },
    })
    .on("head", {
      element(el) {
        el.append(
          `<link rel="canonical" href="${esc(canonical)}">` +
            `<meta property="og:title" content="${esc(product!.title)}">` +
            `<meta property="og:description" content="${esc(description)}">` +
            `<meta property="og:url" content="${esc(canonical)}">` +
            `<meta name="twitter:title" content="${esc(product!.title)}">` +
            `<meta name="twitter:description" content="${esc(description)}">` +
            `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, "\\u003c")}</script>`,
          { html: true }
        );
      },
    })
    .transform(res);

  const headers = new Headers(rewritten.headers);
  headers.set("Cache-Control", "public, max-age=120");
  return new Response(rewritten.body, { status: 200, headers });
}

/** Static pages worth crawling. /cart and /success are excluded by robots.txt. */
const SITEMAP_STATIC = ["/", "/shop", "/about", "/contact", "/privacy", "/terms"];

/** sitemap.xml: the static pages plus every real product URL. */
async function serveSitemap(env: Env): Promise<Response> {
  let handles: string[] = [];
  try {
    const catalog = await getCatalog(env);
    handles = catalog.products.map((p) => p.handle);
  } catch (err: any) {
    // Serve the static pages rather than a 500. A sitemap that errors teaches a
    // crawler the endpoint is unreliable and gets it fetched less often.
    console.error("sitemap catalog lookup failed:", err?.message ?? err);
  }

  const urls = [
    ...SITEMAP_STATIC.map((p) => `${SITE_ORIGIN}${p}`),
    ...handles.map((h) => `${SITE_ORIGIN}/p/${encodeURIComponent(h)}`),
  ];

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${esc(u)}</loc></url>\n`).join("") +
    `</urlset>\n`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=600",
    },
  });
}

/** 404 for a slug with no product, marked noindex so a stray link cannot index it. */
function notFoundPage(handle: string): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Not found — nightly build</title>
<meta name="description" content="This drop does not exist.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/style.css">
</head>
<body style="margin:0;background:#0b0d10;color:#edebe4;font-family:system-ui,sans-serif">
<main style="max-width:44rem;margin:0 auto;padding:6rem 1.5rem">
<h1 style="font-size:1.6rem;margin:0 0 .75rem">No drop at this address.</h1>
<p style="opacity:.75;margin:0 0 1.75rem">${handle ? `Nothing is published under &ldquo;${esc(handle)}&rdquo;.` : "That link is missing a product."}</p>
<a href="/shop" style="color:#edebe4">Browse the shop &rarr;</a>
</main>
</body>
</html>`;
  return new Response(body, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

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
    const productId = String(item?.productId ?? "");
    const variantId = Number(item?.variantId);
    const quantity = Math.max(1, Math.min(20, Number(item?.quantity) || 1));
    if (!Number.isFinite(variantId)) continue;

    // Printify variant ids are shared across every product built on the same
    // blueprint (all tees share ids, all hoodies share ids, etc.), so we MUST
    // match on the specific product id the customer chose. Matching by variant
    // id alone would grab the wrong design.
    const owner = catalog.products.find((p) => p.id === productId);
    const variant = owner ? findVariant(owner, variantId) : undefined;
    if (!owner || !variant || !variant.is_enabled) {
      return json({ error: "invalid_item", productId, variantId }, 400);
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
  return json({
    url: session.url,
    id: session.id,
    lines: lines.map((l) => ({ name: l.name, unitAmount: l.unitAmount, quantity: l.quantity })),
  });
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
