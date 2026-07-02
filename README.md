# nightly build

E-commerce storefront for **Nightly Build**, a Courtright Collective sub-brand.
Merch printed on demand by **Printify**, paid for with **Stripe**, served from a single
**Cloudflare Worker with static assets**. Lives at **nightlybuild.courtrightco.com**.

- Frontend: static HTML/CSS/vanilla JS in `public/` (no framework, no build step).
- Backend: one TypeScript Worker in `src/` serving `/api/*` (Printify catalog + Stripe).
- Product data source of truth: Printify shop **28049090** (read via API; we never use
  Printify's own storefront and never call any Printify publish endpoint).

---

## Architecture

```
Browser ──▶ Cloudflare Worker (src/worker.ts)
              ├─ /api/*  → catalog, product, suggest, checkout, stripe-webhook, session
              └─ else    → static assets from public/ (ASSETS binding)

/api/catalog ──▶ Printify products.json (paginated) ─▶ normalize ─▶ cache in CATALOG_KV (~10 min)
/api/checkout ─▶ re-price server-side ─▶ Stripe Checkout Session ─▶ hosted checkout
Stripe webhook ─▶ verify signature ─▶ create Printify order (idempotent via external_id)
```

Key files:

| File | Purpose |
|---|---|
| `src/worker.ts` | Router: `/api/*` + clean-URL routing (`/p/:handle` → product shell) |
| `src/printify.ts` | Fetch + normalize Printify products, KV cache with `?refresh=1` bypass |
| `src/stripe.ts` | Create Checkout Session, retrieve session, verify webhook signature |
| `src/fulfillment.ts` | Turn a paid session into a Printify order (idempotent) |
| `public/js/app.js` | Cart state (localStorage), drawer, toast, header count, mobile bar |
| `public/js/*.js` | Per-page controllers (home, shop, product, cart, success) |

---

## Environment variables

Secrets are **never** committed. Non-secret config lives in `[vars]` in `wrangler.toml`.

| Name | Where | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | secret | Use `sk_test_…` while building |
| `STRIPE_WEBHOOK_SECRET` | secret | `whsec_…` from the webhook endpoint |
| `PRINTIFY_API_TOKEN` | secret | Printify personal access token |
| `STRIPE_PUBLISHABLE_KEY` | `[vars]` | `pk_test_…`; safe to expose to the browser |
| `PRINTIFY_SHOP_ID` | `[vars]` | `28049090` (the nightlybuild shop) |
| `SITE_URL` | `[vars]` | `https://nightlybuild.courtrightco.com` |

### Set the production secrets

```bash
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put PRINTIFY_API_TOKEN
```

---

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars     # then fill in TEST-mode keys + Printify token
wrangler kv namespace create CATALOG_KV          # paste id + preview_id into wrangler.toml
npm run dev                        # http://localhost:8787
```

`.dev.vars` holds your local secrets and is git-ignored. Never commit it.

Test the catalog: open `http://localhost:8787/api/catalog` (add `?refresh=1` to bypass the
KV cache). Products only appear here if the Printify token is valid and the shop has
products with **enabled** variants (drafts are fine, we read them via API).

### End-to-end test (Stripe test mode)

1. Run `npm run dev`.
2. In another terminal, forward Stripe test webhooks to the local Worker:
   ```bash
   stripe listen --forward-to localhost:8787/api/stripe-webhook
   ```
   Copy the `whsec_…` it prints into `.dev.vars` as `STRIPE_WEBHOOK_SECRET`, restart dev.
3. Add a product to the cart → Checkout → pay with test card `4242 4242 4242 4242`,
   any future expiry, any CVC, any ZIP.
4. On `checkout.session.completed`, the Worker creates a **Printify order** in shop 28049090
   (visible under Orders). If the shop's order approval is **Manual**, the order waits for
   your approval — we intentionally do not auto-submit it to production.

---

## Stripe webhook (production)

1. Stripe Dashboard → Developers → Webhooks → **Add endpoint**.
2. Endpoint URL: `https://nightlybuild.courtrightco.com/api/stripe-webhook`
3. Events to send: **`checkout.session.completed`**.
4. Copy the signing secret (`whsec_…`) and set it:
   `wrangler secret put STRIPE_WEBHOOK_SECRET`.

The Worker verifies the `Stripe-Signature` header (HMAC-SHA256, 5-min tolerance) before
acting, and dedupes retries using the Stripe session id as the Printify `external_id` plus a
KV marker, so a replayed webhook never creates a second order.

---

## Deploy (GitHub → Cloudflare auto-deploy)

This repo is `ccapp-coder/nightlybuild`. Like the other Courtright sites, it auto-deploys via
the **Cloudflare Workers & Pages GitHub App**:

- Push to `main` → Cloudflare builds and deploys within ~30–60 seconds.
- Custom domain `nightlybuild.courtrightco.com` is attached to the `nightlybuild` Worker.
- **Do not delete or rename `wrangler.toml`** — the Cloudflare build needs it.
- If pushes stop triggering builds, check the GitHub App's repo access
  (github.com/settings/installations) and confirm `nightlybuild` is in the list.

Before the first deploy, in the Cloudflare dashboard for the `nightlybuild` Worker:

1. Create the KV namespace and bind it as `CATALOG_KV` (id + preview_id in `wrangler.toml`).
2. Add the three secrets (Stripe secret + webhook + Printify token).
3. Add the custom domain `nightlybuild.courtrightco.com`.

Manual deploy (if ever needed): `npm run deploy`.

---

## API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/catalog` | GET | Normalized product list (enabled variants only). `?refresh=1` bypasses cache. |
| `/api/product?handle=` | GET | One product with full variants for the product page. |
| `/api/suggest?product=ID` | GET | Up to 6 related products (same type or shared theme tag). |
| `/api/checkout` | POST | `{items:[{variantId,quantity}]}` → re-prices server-side, returns Stripe session URL. |
| `/api/stripe-webhook` | POST | Verifies signature, creates the Printify order. |
| `/api/session?id=` | GET | Safe order summary for the success page. |
| `/api/config` | GET | Public Stripe publishable key. |

---

## Notes / decisions

- **Prices are always recomputed server-side** at checkout from the live catalog. Client cart
  prices are display-only and never trusted.
- **Product type** (Tee / Mug / Tumbler / Hoodie) is derived from the product title + tags.
  **Drops** come from a Printify tag of the form `drop: <name>`.
- **"Newest" sort** uses Printify's catalog order (the API returns most-recent first).
- The success and cart pages are `noindex`; `robots.txt` disallows `/cart`, `/success`, `/api/`.
- No paid third-party services are used. Ask Dillon before switching to live Stripe keys,
  changing Printify order-approval behavior, or adding any paid service.
