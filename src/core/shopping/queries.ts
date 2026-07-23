/**
 * Product prompt generation (M12a): the two layers, per product, in ONE guarded
 * judge call.
 *
 * Layer 1 (visibility) asks the category questions a shopper types when they do
 * NOT know the product - so those prompts must never name it. Layer 2
 * (reputation) names the product deliberately, which guarantees a mention and
 * therefore measures sentiment, not discovery. The same split the brand check
 * makes between discovery prompts and branded prompts, one level down.
 *
 * Every failure path still produces prompts: the named layer is templatable
 * without a judge, and the category layer falls back to the product descriptor
 * or the brand category. A product with neither loses its visibility layer and
 * the run SAYS so (rule #6) rather than scoring it against nothing.
 */
import { CostGuard, approxTokens, estimateCallUsd } from '../costs.js';
import { excludeCompetitors } from '../queries/index.js';
import { extractBalanced, fold, mentionsTerm } from '../text.js';
import type { BrandProfile, JudgeClient, ProductEntity } from '../types.js';
import { productTerms } from './detect.js';

/** Category prompts asked per product (the layer the ranking delta rests on). */
export const VISIBILITY_PROMPTS_PER_PRODUCT = 3;

/** Product-named prompts asked per product (the reputation layer). */
export const REPUTATION_PROMPTS_PER_PRODUCT = 1;

/** Total prompts a product costs per engine. */
export const PROMPTS_PER_PRODUCT =
  VISIBILITY_PROMPTS_PER_PRODUCT + REPUTATION_PROMPTS_PER_PRODUCT;

/** Which layer a prompt belongs to; they are scored separately. */
export type ProductLayer = 'visibility' | 'reputation';

/** One prompt, bound to the product (by INDEX) that asked for it. */
export interface ProductPrompt {
  /** Index into the run's product list - a key we control, never a name. */
  productIndex: number;
  layer: ProductLayer;
  prompt: string;
}

export interface ProductQueriesResult {
  prompts: ProductPrompt[];
  /** Human-readable notes: fallbacks used, layers skipped. Never silent. */
  notes: string[];
}

export interface ProductQueriesDeps {
  /** Omit to skip generation entirely and use the templates (with a note). */
  judge?: JudgeClient;
  guard: CostGuard;
  /** Projected setup cost for authorization; defaults to a per-model estimate. */
  projectedCostUsd?: number;
}

export interface ProductQueriesOptions {
  generatedAt: string;
  /** Override the per-product category prompt count (tests, future flags). */
  visibilityPerProduct?: number;
}

/** What the product IS, for prompt generation: its descriptor, else the category. */
function subjectOf(
  product: ProductEntity,
  profile: BrandProfile,
): string | undefined {
  // A whitespace-only descriptor is as useless as an absent one, so both fall
  // through to the store category rather than producing "best   ".
  const descriptor = product.descriptor?.trim() ?? '';
  if (descriptor) return descriptor;
  const category = profile.category?.trim() ?? '';
  return category || undefined;
}

/**
 * Deterministic category prompts, used when the judge is unavailable, capped, or
 * gave too few usable ones. Plain English and plainly generic - the judge writes
 * better, locale-aware questions, which is why a run that used these says so.
 */
function templateVisibility(subject: string): string[] {
  return [
    `best ${subject}`,
    `what is the best ${subject} to buy`,
    `which ${subject} would you recommend`,
    `most recommended ${subject}`,
  ];
}

/** Deterministic named prompts. Always available: they only need the name. */
function templateReputation(name: string): string[] {
  return [`is the ${name} worth it?`, `${name} reviews and common complaints`];
}

/** Parse `{ "<index>": { visibility: [...], reputation: [...] } }` from judge output. */
export function parseProductQueries(
  text: string,
  productCount: number,
): Map<number, { visibility: string[]; reputation: string[] }> {
  const out = new Map<number, { visibility: string[]; reputation: string[] }>();
  const json = extractBalanced(text, '{', '}');
  if (json === null) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return out;

  const obj = parsed as Record<string, unknown>;
  // Read by the INDEX we asked for, never by a name the model echoed back: an
  // echoed name arrives mangled ("Presto 10" for "Presto X") and a name-keyed
  // lookup then silently drops that product's prompts (M0-M6 lesson #2).
  for (let i = 0; i < productCount; i++) {
    const row = obj[String(i)];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    out.set(i, {
      visibility: stringList(entry.visibility),
      reputation: stringList(entry.reputation),
    });
  }
  return out;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildGenPrompt(
  profile: BrandProfile,
  products: ProductEntity[],
  visibilityCount: number,
  year: string,
): string {
  const facts = [`Store brand: ${profile.brand}`];
  if (profile.category) facts.push(`Store category: ${profile.category}`);
  if (profile.locale) facts.push(`Locale: ${profile.locale}`);
  if (profile.geo) facts.push(`Location: ${profile.geo}`);

  const productLines = products.map((p, i) => {
    const bits = [`${i}: ${p.name}`];
    // The RESOLVED subject (its descriptor, else the store category), never
    // just the name: handed a bare opaque name, a model invents a category and
    // the merchant is then scored against a market they are not in (live,
    // 2026-07-23, where "Zephyr Q9 Pro" became a robot vacuum).
    const subject = subjectOf(p, profile);
    if (subject) bits.push(`(a ${subject})`);
    if (p.aliases?.length) bits.push(`[also called: ${p.aliases.join(', ')}]`);
    return `- ${bits.join(' ')}`;
  });

  return [
    'You are modeling how a real shopper talks to an AI shopping assistant.',
    'For EACH product below, write two kinds of question.',
    '',
    `"visibility" (write ${visibilityCount} per product): category buying`,
    '  questions a shopper asks when they do NOT know this product yet.',
    '  NEVER name the product, its aliases, or the store brand in these.',
    '  Describe the category, use case, or constraint instead.',
    `"reputation" (write ${REPUTATION_PROMPTS_PER_PRODUCT} per product): a`,
    '  question that DOES name the product, asking whether it is any good.',
    '',
    'Rules for every question:',
    "- Take each product's category from its descriptor when it has one, and",
    '  otherwise from the Store category below. NEVER guess a category from the',
    '  product name: an opaque model name tells you nothing, and questions from',
    '  the wrong category measure nothing about this store.',
    "- Write in the shopper's language, matching the Locale below.",
    '- Make each question self-contained: it is sent on its own, with no',
    '  earlier conversation and no back-references ("this product", "it").',
    '- Prefer concrete wording (a real use case, budget, or spec) over broad',
    '  themes - retrieval layers turn vague themes into nothing.',
    '- Prefer timeless phrasing. If a question needs a year, use the current',
    `  year (${year}) and never a past one.`,
    '',
    facts.join('\n'),
    '',
    'Products (by index):',
    productLines.join('\n'),
    '',
    'Return ONLY a JSON object keyed by the product INDEX as a string, e.g.',
    '{"0": {"visibility": ["..."], "reputation": ["..."]}}.',
  ].join('\n');
}

/** Take the first `n` unique prompts from `preferred`, then from `fallback`. */
function fill(n: number, preferred: string[], fallback: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const prompt of [...preferred, ...fallback]) {
    const key = fold(prompt).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(prompt);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Generate both prompt layers for every product via one guarded judge call.
 *
 * Never throws: a cap or a judge error degrades to templates with a note, the
 * same contract discovery and query generation follow.
 */
export async function generateProductQueries(
  profile: BrandProfile,
  products: ProductEntity[],
  deps: ProductQueriesDeps,
  opts: ProductQueriesOptions,
): Promise<ProductQueriesResult> {
  const { judge, guard } = deps;
  const visibilityCount =
    opts.visibilityPerProduct ?? VISIBILITY_PROMPTS_PER_PRODUCT;
  const notes: string[] = [];
  let generated = new Map<
    number,
    { visibility: string[]; reputation: string[] }
  >();

  if (products.length > 0 && !judge) {
    notes.push(
      'No judge model was available to write product questions; generic template questions were used instead.',
    );
  }

  if (products.length > 0 && judge) {
    const prompt = buildGenPrompt(
      profile,
      products,
      visibilityCount,
      opts.generatedAt.slice(0, 4),
    );
    // Scale the budget with the number of questions asked for, plus headroom for
    // JSON structure and verbose (non-English) phrasing: a truncated response
    // parses to nothing, which would silently mean "templates for everyone".
    const maxTokens = Math.max(
      600,
      products.length * (visibilityCount + REPUTATION_PROMPTS_PER_PRODUCT) * 45,
    );
    const projected =
      deps.projectedCostUsd ??
      estimateCallUsd(judge.model, approxTokens(prompt), maxTokens);

    if (!guard.authorize(projected, 'setup')) {
      notes.push(
        'Setup cost cap reached before writing product questions; generic template questions were used instead.',
      );
    } else {
      let settled = false;
      try {
        const res = await judge.complete(prompt, { maxTokens });
        // settle, not record: `authorize` reserved `projected`.
        guard.settle(projected, res.costUsd, 'setup');
        settled = true;
        generated = parseProductQueries(res.text, products.length);
      } catch (err) {
        // A failed call cost nothing; release the hold so one setup error does
        // not shrink the budget for the whole run.
        if (!settled) guard.settle(projected, 0, 'setup');
        const reason = err instanceof Error ? err.message : String(err);
        notes.push(
          `Could not write product questions (judge error: ${reason}); generic template questions were used instead.`,
        );
      }
    }
  }

  const prompts: ProductPrompt[] = [];
  const missingSubject: string[] = [];
  const borrowedCategory: string[] = [];

  products.forEach((product, productIndex) => {
    const terms = productTerms(product);
    const row = generated.get(productIndex);
    const subject = subjectOf(product, profile);
    if (subject && !product.descriptor?.trim()) {
      borrowedCategory.push(product.name);
    }

    // Visibility prompts must not name the product - a prompt that names it
    // measures nothing about unprompted discovery. Reuses the query module's
    // boundary-aware exclusion so "Aria 2" is caught but "aria" inside another
    // word is not.
    const cleanVisibility = excludeCompetitors(row?.visibility ?? [], terms);
    const visibility = subject
      ? fill(visibilityCount, cleanVisibility, templateVisibility(subject))
      : [];
    if (!subject) {
      missingSubject.push(product.name);
    }

    // Reputation prompts must name it, for the opposite reason.
    const named = (row?.reputation ?? []).filter((p) =>
      terms.some((term) => mentionsTerm(fold(p), term)),
    );
    const reputation = fill(
      REPUTATION_PROMPTS_PER_PRODUCT,
      named,
      templateReputation(product.name),
    );

    for (const prompt of visibility) {
      prompts.push({ productIndex, layer: 'visibility', prompt });
    }
    for (const prompt of reputation) {
      prompts.push({ productIndex, layer: 'reputation', prompt });
    }
  });

  // A product with no descriptor was measured against the STORE's category,
  // which is a real answer to a different question than the merchant may think
  // they asked. Say which products those were, and what category they got.
  if (borrowedCategory.length > 0 && profile.category?.trim()) {
    notes.push(
      `Category questions for ${borrowedCategory.join(', ')} were built from the store category "${profile.category.trim()}" (no descriptor given). Add a descriptor per product for questions that match what each one actually is.`,
    );
  }

  if (missingSubject.length > 0) {
    notes.push(
      `No category questions for ${missingSubject.join(', ')}: give each product a descriptor (what it is) in the products file, or set --category, to measure category visibility. Only the named questions were asked.`,
    );
  }

  return { prompts, notes };
}
