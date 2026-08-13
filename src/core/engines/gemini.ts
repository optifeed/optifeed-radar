/**
 * Gemini adapter (M6): parametric generateContent, with search grounding added
 * when `mode` is grounded. Grounding that is unavailable degrades to a plain
 * answer (the runner surfaces the degrade), never an error.
 */
import type { ParsedResponse, ProviderSpec } from './adapter.js';

/** A bare hostname (`feedon.ai`), as opposed to a prose page title. */
const HOSTNAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Final labels that look like a TLD but are file/framework suffixes. `Node.js`,
 * `Next.js` and `Vue.js` all satisfy HOSTNAME, so without this they became
 * `https://node.js` - a fabricated publisher that parses fine in `new URL()`,
 * reaches the sources table, and is persisted to the snapshot (rule #6). Gemini
 * grounds on developer docs constantly, so these are common titles.
 *
 * Only entries that are NOT real TLDs are listed: `.md`, `.sh`, `.rs`, `.io`
 * and `.ai` are all genuine TLDs and must keep resolving. Rejecting is cheap -
 * the caller falls back to the working (if opaque) redirect URL - so when in
 * doubt this list should grow rather than risk inventing a source.
 */
const NOT_A_TLD = new Set([
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'json',
  'yaml',
  'yml',
  'html',
  'htm',
  'css',
  'txt',
  'xml',
]);

/**
 * The citation URL for one grounding chunk.
 *
 * Gemini returns `web.uri` as an opaque Google REDIRECT
 * (`vertexaisearch.cloud.google.com/grounding-api-redirect/...`) and puts the
 * real publisher in `web.title`. Scoring derives cited domains with
 * `new URL(u).hostname`, so using the uri collapsed every citation in a run to
 * Google's own infrastructure domain and the sources table showed that instead
 * of the publishers (verified live 2026-07-20: 16 citations, 1 reported
 * domain). Those signed redirects also expire, so persisting them rots the
 * evidence. Prefer the title when it really is a hostname; otherwise keep the
 * uri - a working opaque link beats a fabricated one.
 */
function citationUrl(web: {
  uri?: string;
  title?: string;
}): string | undefined {
  const title = web.title?.trim().toLowerCase();
  if (title && HOSTNAME.test(title)) {
    const labels = title.split('.');
    const tld = labels[labels.length - 1] ?? '';
    // A real TLD is alphabetic and at least two characters, and must not be a
    // known file/framework suffix. Anything else keeps the redirect URL: an
    // opaque link that works beats a publisher that does not exist.
    const plausibleTld =
      tld.length >= 2 && /^[a-z]+$/.test(tld) && !NOT_A_TLD.has(tld);
    if (plausibleTld) return `https://${title}`;
  }
  return web.uri;
}

interface GenerateShape {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    groundingMetadata?: {
      groundingChunks?: { web?: { uri?: string; title?: string } }[];
      /** The rewritten queries Gemini actually searched (fanout evidence). */
      webSearchQueries?: string[];
    };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    /** Thinking tokens. Billed at the OUTPUT rate but reported separately. */
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
}

export const geminiSpec: ProviderSpec = {
  id: 'gemini',
  kind: 'parametric',
  // A PINNED snapshot, for the same reason the OpenAI default is one - and here
  // the cost of NOT pinning was measured rather than argued.
  //
  // The history: `gemini-2.5-flash` began returning HTTP 404 ("no longer
  // available to new users", verified live 2026-07-20), so every Gemini run
  // failed, and `gemini-flash-latest` replaced it because an alias cannot 404
  // that way. But it floats, and unlike OpenAI, Gemini ECHOES the resolved id
  // (`modelVersion`) - which is how the drift was caught. On one real `check`
  // run 2026-08-13, that alias resolved to `gemini-3.6-flash` for 7 of 8
  // answers and `gemini-3.7-flash` for the 8th, mid-rollout, inside a single
  // run: one engine's score blended two models. A measurement whose subject can
  // change between two concurrent requests cannot support `diff`, which exists
  // to attribute change over time.
  //
  // Both ids were verified live 2026-08-13: HTTP 200 on `generateContent`, with
  // and without a `maxOutputTokens` cap, and both list `generateContent` in
  // `supportedGenerationMethods`. 3.7 is the newer of the two, so it is the pin.
  //
  // Know the trade, exactly as the OpenAI default states it: a pinned API model
  // is not necessarily the model the consumer Gemini app serves. This column now
  // measures a specific, reproducible model from the family behind that app -
  // fidelity exchanged for reproducibility. Re-pointing at any `-latest` id is a
  // regression, not an update (a test asserts the default contains no "latest").
  defaultModel: 'gemini-3.7-flash',
  supportsGrounded: true,
  endpoint: (_mode, model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  buildRequest: ({ prompt, mode, apiKey, maxTokens }) => ({
    headers: {
      'x-goog-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: {
      contents: [{ parts: [{ text: prompt }] }],
      ...(mode === 'grounded' ? { tools: [{ google_search: {} }] } : {}),
      // Gemini budgets thinking and answer from the SAME maxOutputTokens pool,
      // so a caller-supplied cap must leave room for both. That is now handled
      // upstream: every judge cap is sized by judgeMaxTokens, which adds
      // REASONING_RESERVE_TOKENS, so nothing here needs to constrain thinking.
      //
      // Do NOT send `thinkingBudget: 0`. The Gemini 3.x models this adapter
      // asks refuse to have thinking DISABLED and answer HTTP 400
      // INVALID_ARGUMENT, which broke every capped Gemini judge call until
      // 2026-08-13. It is the zero specifically, not the field: measured live
      // that day on gemini-flash-latest, `thinkingBudget: 128` and
      // `thinkingLevel: "low"` both returned 200. So a future maintainer who
      // wants to bound thinking cost rather than disable it has options - they
      // are simply untested here, and headroom made them unnecessary.
      //
      // The ask path passes no cap at all and keeps thinking on: that is what a
      // real Gemini user gets, and it is the answer we are measuring.
      ...(maxTokens
        ? { generationConfig: { maxOutputTokens: maxTokens } }
        : {}),
    },
  }),
  parse: (json): ParsedResponse => {
    const r = json as GenerateShape;
    const candidate = r.candidates?.[0];
    // Thinking models can return reasoning parts alongside the answer; splicing
    // those into the text would score private reasoning as what the engine said.
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p.thought !== true)
      .map((p) => p.text ?? '')
      .join('');
    const citations = candidate?.groundingMetadata?.groundingChunks
      ?.map((c) => (c.web ? citationUrl(c.web) : undefined))
      .filter((u): u is string => Boolean(u));
    // What Gemini actually searched, where it exposes it. Recorded when present,
    // never fabricated (rule #6) - the OpenAI grounded path surfaces the same
    // evidence from web_search_call.action.queries.
    const fanoutQueries =
      candidate?.groundingMetadata?.webSearchQueries?.filter((q): q is string =>
        Boolean(q),
      );
    return {
      text,
      citations: citations && citations.length > 0 ? citations : undefined,
      fanoutQueries:
        fanoutQueries && fanoutQueries.length > 0 ? fanoutQueries : undefined,
      usage: r.usageMetadata
        ? {
            input: r.usageMetadata.promptTokenCount ?? 0,
            // Thinking tokens are billed at the output rate (official pricing
            // sheet: "Output ... (includes thinking tokens)"), so charging only
            // candidatesTokenCount silently under-reports spend - on a real
            // captured call, by 1274 tokens. Hard rule #5.
            output:
              (r.usageMetadata.candidatesTokenCount ?? 0) +
              (r.usageMetadata.thoughtsTokenCount ?? 0),
          }
        : undefined,
      model: r.modelVersion,
    };
  },
};
