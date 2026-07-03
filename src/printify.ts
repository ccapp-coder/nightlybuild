// Printify catalog: fetch (paginated), normalize, and cache in KV.
import type { Env, Catalog, NBProduct, NBVariant, NBColor } from "./types";

const PRINTIFY_API = "https://api.printify.com/v1";
const CACHE_KEY = "catalog:v1";
const CACHE_TTL_SECONDS = 600; // ~10 minutes
const UA = "nightlybuild-store/1.0 (+https://nightlybuild.courtrightco.com)";

// --- Public: cached catalog with ?refresh bypass ---
export async function getCatalog(env: Env, refresh = false): Promise<Catalog> {
  if (!refresh) {
    const cached = await env.CATALOG_KV.get<Catalog>(CACHE_KEY, "json");
    if (cached) return cached;
  }
  const catalog = await buildCatalog(env);
  // KV TTL handles expiry; we also keep updatedAt for observability.
  await env.CATALOG_KV.put(CACHE_KEY, JSON.stringify(catalog), {
    expirationTtl: CACHE_TTL_SECONDS,
  });
  return catalog;
}

export function findProduct(catalog: Catalog, idOrHandle: string): NBProduct | undefined {
  return catalog.products.find((p) => p.id === idOrHandle || p.handle === idOrHandle);
}

export function findVariant(product: NBProduct, variantId: number): NBVariant | undefined {
  return product.variants.find((v) => v.id === variantId);
}

// --- Build the normalized catalog from the Printify API ---
async function buildCatalog(env: Env): Promise<Catalog> {
  const shopId = env.PRINTIFY_SHOP_ID;
  const raw = await fetchAllProducts(env, shopId);
  const products = raw
    .map(normalizeProduct)
    .filter((p): p is NBProduct => p !== null && p.variants.length > 0);
  return { updatedAt: Date.now(), products };
}

async function fetchAllProducts(env: Env, shopId: string): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  // Printify caps limit at 50; loop pages until we've read the last one.
  for (;;) {
    const url = `${PRINTIFY_API}/shops/${shopId}/products.json?limit=50&page=${page}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.PRINTIFY_API_TOKEN}`,
        "User-Agent": UA,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Printify products fetch failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json: any = await res.json();
    const data: any[] = json.data ?? [];
    all.push(...data);
    const lastPage = json.last_page ?? page;
    if (page >= lastPage || data.length === 0) break;
    page += 1;
    if (page > 50) break; // hard safety cap
  }
  return all;
}

// --- Normalization helpers ---
function normalizeProduct(p: any): NBProduct | null {
  if (!p || !p.id) return null;

  // Map option-value id -> { type, title, hex }
  const optionMap = new Map<number, { type: string; title: string; hex: string | null }>();
  for (const opt of p.options ?? []) {
    const type = String(opt.type ?? opt.name ?? "").toLowerCase();
    for (const val of opt.values ?? []) {
      const hex = Array.isArray(val.colors) && val.colors.length ? String(val.colors[0]) : null;
      optionMap.set(val.id, { type, title: val.title, hex });
    }
  }

  // Per-variant mockup: first image (prefer front/default) whose variant_ids includes it.
  const images: any[] = Array.isArray(p.images) ? p.images : [];
  const imageForVariant = (variantId: number): string | null => {
    const matches = images.filter((im) => (im.variant_ids ?? []).includes(variantId));
    if (!matches.length) return null;
    matches.sort(imageSort);
    return matches[0]?.src ?? null;
  };

  const variants: NBVariant[] = (p.variants ?? []).map((v: any): NBVariant => {
    const { color, colorHex, size } = variantColorSize(v, optionMap);
    return {
      id: v.id,
      color,
      colorHex,
      size,
      price: typeof v.price === "number" ? v.price : Number(v.price) || 0,
      is_enabled: Boolean(v.is_enabled),
      image: imageForVariant(v.id),
    };
  });

  const enabled = variants.filter((v) => v.is_enabled);
  if (enabled.length === 0) return null; // nothing sellable

  const prices = enabled.map((v) => v.price);
  const priceMin = Math.min(...prices);
  const priceMax = Math.max(...prices);

  // Distinct colors / sizes from enabled variants, order preserved.
  const colors: NBColor[] = [];
  const seenColor = new Set<string>();
  const sizes: string[] = [];
  const seenSize = new Set<string>();
  for (const v of enabled) {
    if (v.color && !seenColor.has(v.color)) {
      seenColor.add(v.color);
      colors.push({ name: v.color, hex: v.colorHex });
    }
    if (v.size && !seenSize.has(v.size)) {
      seenSize.add(v.size);
      sizes.push(v.size);
    }
  }

  // Gallery: front/default images first, deduped by src.
  const gallery: string[] = [];
  const seenSrc = new Set<string>();
  for (const im of [...images].sort(imageSort)) {
    if (im.src && !seenSrc.has(im.src)) {
      seenSrc.add(im.src);
      gallery.push(im.src);
    }
  }

  const tags: string[] = Array.isArray(p.tags) ? p.tags.map((t: any) => String(t)) : [];
  const title = String(p.title ?? "Untitled");

  return {
    id: String(p.id),
    handle: slugify(title, String(p.id)),
    title,
    description: stripHtml(String(p.description ?? "")),
    tags,
    productType: detectType(title, tags),
    drop: detectDrop(tags),
    priceMin,
    priceMax,
    colors,
    sizes,
    images: gallery.slice(0, 12),
    variants,
    blueprint_id: typeof p.blueprint_id === "number" ? p.blueprint_id : null,
    print_provider_id: typeof p.print_provider_id === "number" ? p.print_provider_id : null,
  };
}

function variantColorSize(
  v: any,
  optionMap: Map<number, { type: string; title: string; hex: string | null }>
): { color: string; colorHex: string | null; size: string } {
  let color = "";
  let colorHex: string | null = null;
  let size = "";
  for (const optId of v.options ?? []) {
    const info = optionMap.get(optId);
    if (!info) continue;
    if (info.type.includes("color")) {
      color = info.title;
      colorHex = info.hex;
    } else if (info.type.includes("size")) {
      size = info.title;
    }
  }
  // Fallback: parse "Black / M"-style titles when options are missing.
  if ((!color || !size) && typeof v.title === "string" && v.title.includes("/")) {
    const parts = v.title.split("/").map((s: string) => s.trim());
    if (!color && parts[0]) color = parts[0];
    if (!size && parts[1]) size = parts[1];
  }
  return { color, colorHex, size };
}

// front/default images sort earliest
function imageSort(a: any, b: any): number {
  const score = (im: any) => {
    let s = 0;
    if (im.is_default) s -= 4;
    if (String(im.position ?? "").toLowerCase() === "front") s -= 2;
    if (im.is_selected_for_publishing) s -= 1;
    return s;
  };
  return score(a) - score(b);
}

function detectType(title: string, tags: string[]): NBProduct["productType"] {
  const hay = (title + " " + tags.join(" ")).toLowerCase();
  if (/\b(hoodie|sweatshirt|crewneck|pullover)\b/.test(hay)) return "Hoodie";
  if (/\btumbler\b/.test(hay)) return "Tumbler";
  if (/\bmug\b/.test(hay)) return "Mug";
  if (/\b(tee|t-?shirt|shirt)\b/.test(hay)) return "Tee";
  return "Other";
}

function detectDrop(tags: string[]): string | null {
  for (const t of tags) {
    const m = t.match(/^drop[:\-\s]+(.+)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

export function slugify(title: string, id: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = id.slice(-6);
  return base ? `${base}-${suffix}` : suffix;
}

function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
