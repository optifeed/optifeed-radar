/**
 * The merchant's product list (M12a): parse it, cap it, and freeze its order.
 *
 * M12a has NO discovery of any kind - the merchant names their products, via
 * `--products` or `--products-file`. Both paths land here so the two can never
 * drift, and the surviving input ORDER is the merchant's own ranking, which the
 * ranking delta is measured against.
 */
import { parse } from 'yaml';
import { SCHEMA_VERSION, type ProductEntity } from '../types.js';

/**
 * Products accepted in one run. A cap rather than a suggestion: each product
 * costs its own prompts on every engine, so an uncapped list is an uncapped
 * bill (hard rule #5).
 */
export const MAX_PRODUCTS = 10;

/** Thrown when a product list is unusable (bad YAML, no name, empty list). */
export class ProductListError extends Error {
  constructor(
    public readonly detail: string,
    public readonly source?: string,
  ) {
    super(`Invalid product list${source ? ` at ${source}` : ''}: ${detail}`);
    this.name = 'ProductListError';
  }
}

/** Parse `--products "A, B, C"`; order is preserved, blanks are dropped. */
export function parseProductsFlag(value: string): ProductEntity[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

/**
 * Parse `--products-file`. Accepts the documented mapping form
 * (`products:` with `{name, aliases?, descriptor?}` entries) and the bare list
 * of names people actually write first (lesson #4: parse every real shape).
 *
 * `schema_version` is OPTIONAL here, unlike every artifact WE write: this file
 * is hand-authored input, and demanding a version line from a merchant typing
 * three product names would be hostile. When one IS present it is checked, so a
 * file copied from a future release fails loudly rather than half-parsing.
 */
export function parseProductsFile(
  text: string,
  source?: string,
): ProductEntity[] {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ProductListError(
      err instanceof Error ? err.message : 'not valid YAML',
      source,
    );
  }

  let entries: unknown;
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const version = obj.schema_version;
    if (version !== undefined && version !== SCHEMA_VERSION) {
      const found = typeof version === 'string' ? version : 'of the wrong type';
      throw new ProductListError(
        `schema_version ${found} is not supported (expected ${SCHEMA_VERSION})`,
        source,
      );
    }
    entries = obj.products;
  }

  if (!Array.isArray(entries)) {
    throw new ProductListError(
      'expected a list of products, or a "products:" list',
      source,
    );
  }

  return entries.map((entry, i) => {
    if (typeof entry === 'string') {
      const name = entry.trim();
      if (!name)
        throw new ProductListError(`product ${i + 1} has no name`, source);
      return { name };
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ProductListError(`product ${i + 1} is not a mapping`, source);
    }
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name)
      throw new ProductListError(`product ${i + 1} has no name`, source);
    const aliases = stringList(row.aliases);
    const descriptor =
      typeof row.descriptor === 'string' && row.descriptor.trim()
        ? row.descriptor.trim()
        : undefined;
    return {
      name,
      ...(aliases ? { aliases } : {}),
      ...(descriptor ? { descriptor } : {}),
    };
  });
}

/** A capped, de-duped product list plus the notes explaining what changed. */
export interface ResolvedProducts {
  /** The products to run, in the order they were given. */
  products: ProductEntity[];
  /** Human-readable notes about entries that were dropped (never silent). */
  notes: string[];
}

/**
 * Normalize a parsed list into the run's products: de-dupe, cap, keep order.
 *
 * Input order is NOT a ranking (it was read as one until 2026-07-24); it only
 * decides which entries fall off the end of the cap, and breaks ties in the
 * report. Dropping is always REPORTED: a merchant who pasted 13 products and
 * silently got 10 would read the report as covering their whole shelf
 * (rule #6).
 */
export function resolveProducts(input: ProductEntity[]): ResolvedProducts {
  const notes: string[] = [];
  const seen = new Set<string>();
  const unique: ProductEntity[] = [];
  let duplicates = 0;
  for (const product of input) {
    const key = product.name.trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    unique.push(product);
  }
  if (duplicates > 0) {
    notes.push(
      `Dropped ${duplicates} duplicate product ${duplicates === 1 ? 'name' : 'names'}; the first entry of each was kept.`,
    );
  }

  if (unique.length === 0) {
    throw new ProductListError('no products were given');
  }

  const products = unique.slice(0, MAX_PRODUCTS);
  const dropped = unique.length - products.length;
  if (dropped > 0) {
    notes.push(
      `Only the first ${MAX_PRODUCTS} products you listed were checked; ${dropped} further ${dropped === 1 ? 'product was' : 'products were'} not run.`,
    );
  }

  return { products, notes };
}
