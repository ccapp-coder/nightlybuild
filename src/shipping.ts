// Real shipping cost for a cart, from each product's Printify shipping profile.
// Per product type (blueprint + provider): the first unit pays the first-item rate, every
// other unit the additional-item rate. Grouping by blueprint can only over-estimate.
import type { Env, NBProduct } from "./types";

const PRINTIFY_API = "https://api.printify.com/v1";
const UA = "nightlybuild-store/1.0 (+https://nightlybuild.courtrightco.com)";
const SHIP_TTL = 60 * 60 * 24; // 24h

/** Countries we sell to. Checkout ships only to the one the shopper picked. */
export const SHIP_COUNTRIES = ["US", "CA", "GB", "AU", "NZ", "IE"] as const;
export type ShipCountry = (typeof SHIP_COUNTRIES)[number];

export function shipCountry(value: unknown, request: Request): ShipCountry {
  const v = String(value ?? "").toUpperCase();
  if ((SHIP_COUNTRIES as readonly string[]).includes(v)) return v as ShipCountry;
  const geo = String((request as any).cf?.country ?? "").toUpperCase();
  return (SHIP_COUNTRIES as readonly string[]).includes(geo) ? (geo as ShipCountry) : "US";
}

interface ShipProfile {
  variant_ids: number[];
  first_item: { cost: number; currency: string };
  additional_items: { cost: number; currency: string };
  countries: string[];
}

async function profiles(env: Env, bp: number, pp: number): Promise<ShipProfile[]> {
  const key = `ship:${bp}:${pp}`;
  const cached = await env.CATALOG_KV.get<ShipProfile[]>(key, "json");
  if (cached) return cached;
  const res = await fetch(`${PRINTIFY_API}/catalog/blueprints/${bp}/print_providers/${pp}/shipping.json`, {
    headers: { Authorization: `Bearer ${env.PRINTIFY_API_TOKEN}`, "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`Printify shipping ${bp}/${pp} failed (${res.status})`);
  const j: any = await res.json();
  const list: ShipProfile[] = j.profiles ?? [];
  await env.CATALOG_KV.put(key, JSON.stringify(list), { expirationTtl: SHIP_TTL });
  return list;
}

function pick(list: ShipProfile[], variantId: number, country: string): ShipProfile | null {
  const forVariant = list.filter((p) => (p.variant_ids ?? []).includes(variantId));
  const pool = forVariant.length ? forVariant : list;
  return (
    pool.find((p) => p.countries.includes(country)) ??
    pool.find((p) => p.countries.includes("REST_OF_THE_WORLD")) ??
    null
  );
}

export interface ShipLine {
  product: NBProduct;
  variantId: number;
  quantity: number;
}

/** USD cents Printify will charge to ship these lines to `country`. Throws "no_shipping" if it can't. */
export async function shippingCents(env: Env, lines: ShipLine[], country: string): Promise<number> {
  const groups = new Map<string, ShipLine[]>();
  for (const l of lines) {
    const key = `${l.product.blueprint_id}:${l.product.print_provider_id}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  let total = 0;
  for (const [key, group] of groups) {
    const [bp, pp] = key.split(":").map(Number);
    if (!bp || !pp) throw new Error("no_shipping");
    const list = await profiles(env, bp, pp);
    let firstMax = 0;
    let addSum = 0;
    let addMin = Infinity;
    let units = 0;
    for (const l of group) {
      const prof = pick(list, l.variantId, country);
      if (!prof) throw new Error("no_shipping");
      firstMax = Math.max(firstMax, prof.first_item.cost);
      addSum += prof.additional_items.cost * l.quantity;
      addMin = Math.min(addMin, prof.additional_items.cost);
      units += l.quantity;
    }
    total += firstMax + addSum - (units > 0 ? addMin : 0);
  }
  return total;
}
