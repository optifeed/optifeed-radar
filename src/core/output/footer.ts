/**
 * The single call-to-action every human-readable report ends with (copy rules:
 * one footer CTA constant, defined once in `core/output`). No hype, no
 * free-vs-paid framing, no em-dash.
 */
export const FOOTER_CTA = 'More at optifeed.com';

/**
 * Audit-only honesty caveat: the zero-key audit queries no AI engines, so its
 * 0-100 is a static-readiness score, not the AI Visibility Score. Shown in the
 * audit body so it never rides on the shared {@link FOOTER_CTA} (which a `check`
 * run - where engines ARE queried - also uses).
 */
export const AUDIT_ONLY_NOTE =
  'Static audit only - no AI engines were queried.';
