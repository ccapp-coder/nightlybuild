// Shared types for the Nightly Build Worker.

export interface Env {
  ASSETS: Fetcher;
  CATALOG_KV: KVNamespace;

  // Secrets (wrangler secret put ...)
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  PRINTIFY_API_TOKEN: string;

  // Vars
  PRINTIFY_SHOP_ID: string;
  STRIPE_PUBLISHABLE_KEY: string;
  SITE_URL: string;
}

// ---- Normalized catalog shapes (what the frontend consumes) ----

export interface NBVariant {
  id: number;
  color: string;
  colorHex: string | null;
  size: string;
  price: number; // cents
  is_enabled: boolean;
  image: string | null; // mockup keyed to this variant, if any
}

export interface NBColor {
  name: string;
  hex: string | null;
}

export interface NBProduct {
  id: string;
  handle: string;
  title: string;
  description: string; // plain text
  tags: string[];
  productType: "Tee" | "Mug" | "Tumbler" | "Hoodie" | "Other";
  drop: string | null;
  priceMin: number; // cents
  priceMax: number; // cents
  colors: NBColor[];
  sizes: string[];
  images: string[]; // gallery, front/default first
  variants: NBVariant[];
  // Needed server-side for Printify order creation:
  blueprint_id: number | null;
  print_provider_id: number | null;
}

export interface Catalog {
  updatedAt: number;
  products: NBProduct[];
}
