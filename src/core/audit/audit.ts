/**
 * The zero-LLM AI-readiness audit (M3) - the first shippable command and the
 * "why" layer merged into `check`.
 *
 * `buildAuditReport` is a PURE, deterministic function over already-fetched
 * inputs: same input in, same report out (no clock, no network). Each facet is
 * scored against published weights ({@link AUDIT_WEIGHTS}) and emits findings.
 */
import type { ExtractedPage } from '../fetcher/index.js';
import { SCHEMA_VERSION, type Finding, type Severity } from '../types.js';
import { type BotAccess, botAccessTable } from './robots.js';

/** Published category weights (sum to 100). Auditable > clever. */
export const AUDIT_WEIGHTS = [
  { id: 'robots', label: 'AI crawler access', weight: 40 },
  { id: 'structured', label: 'Structured data', weight: 25 },
  { id: 'llms', label: 'llms.txt', weight: 15 },
  { id: 'meta', label: 'Meta basics', weight: 15 },
  { id: 'sitemap', label: 'Sitemap', weight: 5 },
] as const;

type CategoryId = (typeof AUDIT_WEIGHTS)[number]['id'];

const weightOf = (id: CategoryId): number =>
  AUDIT_WEIGHTS.find((c) => c.id === id)!.weight;

/** Inputs the audit scores. Nulls mean "absent or could not be fetched". */
export interface AuditInput {
  domain: string;
  robotsTxt: string | null;
  llmsTxt: string | null;
  llmsFullTxt: string | null;
  homepage: ExtractedPage | null;
  sampledPages: ExtractedPage[];
  sitemap: { present: boolean; parseable: boolean; urlCount: number } | null;
}

export interface AuditCategoryScore {
  id: CategoryId;
  label: string;
  weight: number;
  earned: number;
}

export interface AuditReport {
  schema_version: string;
  domain: string;
  score: number;
  findings: Finding[];
  bots: BotAccess[];
  categories: AuditCategoryScore[];
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

function collectJsonLdTypes(pages: ExtractedPage[]): Set<string> {
  const types = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      // Array-form JSON-LD (a bare array of entities) is common; recurse in.
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const t = obj['@type'];
    for (const one of Array.isArray(t) ? t : [t]) {
      if (typeof one === 'string') types.add(one.toLowerCase());
    }
    const graph = obj['@graph'];
    if (Array.isArray(graph)) graph.forEach(visit);
  };
  for (const page of pages) page.jsonLd.forEach(visit);
  return types;
}

function llmsHasLinks(text: string): boolean {
  // A markdown link necessarily contains a URL, so one URL check covers both.
  return /https?:\/\//.test(text);
}

/** Build the deterministic audit report from fetched inputs. */
export function buildAuditReport(input: AuditInput): AuditReport {
  const findings: Finding[] = [];
  const categories: AuditCategoryScore[] = [];
  const add = (
    id: string,
    severity: Severity,
    message: string,
    extra?: Partial<Finding>,
  ) => findings.push({ id, severity, message, ...extra });

  // --- AI crawler access (robots.txt) ---
  const bots = botAccessTable(input.robotsTxt);
  const allowed = bots.filter((b) => b.access === 'allowed').length;
  const robotsFraction = allowed / bots.length;
  if (input.robotsTxt === null) {
    add(
      'robots.missing',
      'info',
      'No robots.txt found; all AI crawlers are allowed by default.',
    );
  }
  for (const bot of bots) {
    if (bot.access === 'blocked') {
      add(
        `robots.blocked.${bot.bot}`,
        'warn',
        `${bot.bot} (${bot.vendor}) is blocked in robots.txt.`,
        { affectedEngines: [] },
      );
    }
  }
  categories.push({
    id: 'robots',
    label: 'AI crawler access',
    weight: weightOf('robots'),
    earned: weightOf('robots') * robotsFraction,
  });

  // --- Structured data (JSON-LD) ---
  const types = collectJsonLdTypes(input.sampledPages);
  const hasJsonLd = input.sampledPages.some((p) => p.jsonLd.length > 0);
  let structuredFraction = 0;
  if (!hasJsonLd) {
    add(
      'structured.missing',
      'warn',
      'No structured data (JSON-LD) found on the sampled pages.',
    );
  } else {
    structuredFraction += 0.5;
    if (types.has('organization')) structuredFraction += 0.25;
    else
      add('structured.organization', 'info', 'No Organization schema found.');
    if (types.has('website')) structuredFraction += 0.25;
    else add('structured.website', 'info', 'No WebSite schema found.');
  }
  categories.push({
    id: 'structured',
    label: 'Structured data',
    weight: weightOf('structured'),
    earned: weightOf('structured') * structuredFraction,
  });

  // --- llms.txt ---
  let llmsFraction = 0;
  const llms = input.llmsTxt?.trim() ?? '';
  if (!llms) {
    add('llms.missing', 'warn', 'No llms.txt found.');
  } else {
    llmsFraction += 0.6;
    if (llmsHasLinks(llms)) llmsFraction += 0.4;
    else add('llms.nolinks', 'info', 'llms.txt has no links.');
  }
  if ((input.llmsFullTxt?.trim() ?? '') !== '') {
    add(
      'llms.full',
      'info',
      'llms-full.txt is present (good for AI ingestion).',
    );
  }
  categories.push({
    id: 'llms',
    label: 'llms.txt',
    weight: weightOf('llms'),
    earned: weightOf('llms') * llmsFraction,
  });

  // --- Meta basics ---
  let metaFraction = 0;
  const page = input.homepage;
  if (!page) {
    add(
      'meta.homepage',
      'error',
      'The homepage could not be fetched or parsed.',
    );
  } else {
    if (page.title) metaFraction += 0.3;
    else add('meta.title', 'error', 'Homepage has no <title>.');
    if (page.metaDescription) metaFraction += 0.3;
    else add('meta.description', 'warn', 'Homepage has no meta description.');
    if (page.canonical) metaFraction += 0.2;
    else add('meta.canonical', 'info', 'Homepage has no canonical link.');
    if (Object.keys(page.og).length > 0) metaFraction += 0.1;
    else add('meta.og', 'info', 'Homepage has no Open Graph tags.');
    if (page.lang) metaFraction += 0.1;
    else add('meta.lang', 'info', 'Homepage <html> has no lang attribute.');
  }
  categories.push({
    id: 'meta',
    label: 'Meta basics',
    weight: weightOf('meta'),
    earned: weightOf('meta') * metaFraction,
  });

  // --- Sitemap ---
  let sitemapFraction = 0;
  if (!input.sitemap?.present) {
    add('sitemap.missing', 'warn', 'No sitemap found.');
  } else if (!input.sitemap.parseable) {
    add('sitemap.unparseable', 'warn', 'Sitemap could not be parsed.');
  } else {
    sitemapFraction = 1;
  }
  categories.push({
    id: 'sitemap',
    label: 'Sitemap',
    weight: weightOf('sitemap'),
    earned: weightOf('sitemap') * sitemapFraction,
  });

  const score = Math.round(categories.reduce((s, c) => s + c.earned, 0));
  findings.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );

  return {
    schema_version: SCHEMA_VERSION,
    domain: input.domain,
    score,
    findings,
    bots,
    categories,
  };
}
