/**
 * Pure scoring aggregation (M7). The published formula and its weights live
 * here (mirrored verbatim in `METHODOLOGY.md`); `SCORE_WEIGHTS` is the single
 * source of truth. No network, no judge - deterministic given the mentions.
 */
import type {
  BrandProfile,
  EngineId,
  EngineKind,
  EngineScore,
  MentionResult,
  ShareOfVoiceRow,
  SourceRow,
} from '../types.js';

/**
 * Published scoring weights (source of truth for `METHODOLOGY.md`). Update the
 * date when you touch a number, and update the doc + its worked example.
 */
export const SCORE_WEIGHTS = {
  /** Weight of mention rate in an engine's 0-1 raw score. */
  mention: 0.6,
  /** Weight of the position component. */
  position: 0.4,
  /** Max +/- swing applied by average sentiment (±15%). */
  sentimentSwing: 0.15,
  /** Composite weight of a grounded engine (cites sources). */
  groundedWeight: 1.5,
  /** Composite weight of a parametric engine. */
  parametricWeight: 1.0,
  lastUpdated: '2026-07-15',
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

const SENTIMENT_VALUE = { positive: 1, neutral: 0, negative: -1 } as const;

/** Aggregate one engine's per-answer results into an {@link EngineScore}. */
export function scoreEngine(
  engine: EngineId,
  kind: EngineKind,
  results: MentionResult[],
): EngineScore {
  const answers = results.length;
  const mentionedResults = results.filter((r) => r.mentioned);
  const mentions = mentionedResults.length;
  const mentionRate = answers === 0 ? 0 : mentions / answers;

  const positions = mentionedResults
    .map((r) => r.position)
    .filter((p): p is number => p !== null);
  const avgPosition =
    positions.length === 0
      ? null
      : positions.reduce((a, b) => a + b, 0) / positions.length;

  // Coverage-aware position: the mean of (1/rank) over ALL answers, so an answer
  // that never mentions the brand contributes 0. A brand absent from half the
  // answers cannot earn full position credit from the half where it leads
  // (being #1-when-present must not mask being missing from the conversation).
  const positionScore =
    answers === 0 ? 0 : positions.reduce((sum, p) => sum + 1 / p, 0) / answers;

  const sentimentAvg =
    mentions === 0
      ? 0
      : mentionedResults.reduce(
          (sum, r) => sum + SENTIMENT_VALUE[r.sentiment],
          0,
        ) / mentions;
  const sentimentMod = 1 + SCORE_WEIGHTS.sentimentSwing * sentimentAvg;

  const raw =
    (SCORE_WEIGHTS.mention * mentionRate +
      SCORE_WEIGHTS.position * positionScore) *
    sentimentMod;
  const score = Math.round(clamp01(raw) * 100);

  return { engine, kind, score, mentionRate, avgPosition, answers, mentions };
}

/** Weighted mean of engine scores; grounded engines weight higher. */
export function compositeScore(engines: EngineScore[]): number {
  let weighted = 0;
  let totalWeight = 0;
  for (const e of engines) {
    const weight =
      e.kind === 'grounded'
        ? SCORE_WEIGHTS.groundedWeight
        : SCORE_WEIGHTS.parametricWeight;
    weighted += e.score * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? 0 : Math.round(weighted / totalWeight);
}

/** Share-of-voice over brand + profile competitors, most-mentioned first. */
export function shareOfVoice(
  results: MentionResult[],
  profile: BrandProfile,
): ShareOfVoiceRow[] {
  // Dedupe (case-insensitively) so a competitor list that repeats the brand or
  // itself never yields duplicate rows; the brand always wins its own row.
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of [profile.brand, ...profile.competitors]) {
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  const counts = new Map<string, number>(names.map((n) => [n, 0]));
  for (const r of results) {
    for (const entity of r.entities) {
      if (counts.has(entity)) counts.set(entity, (counts.get(entity) ?? 0) + 1);
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  return names
    .map((name) => {
      const mentions = counts.get(name) ?? 0;
      return {
        name,
        isBrand: name === profile.brand,
        mentions,
        sharePct: total === 0 ? 0 : round1((mentions / total) * 100),
      };
    })
    .sort((a, b) => b.mentions - a.mentions);
}

/** Aggregate cited domains across all answers, most-cited first. */
export function aggregateSources(results: MentionResult[]): SourceRow[] {
  const counts = new Map<string, number>();
  for (const r of results) {
    for (const domain of r.citedDomains) {
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}
