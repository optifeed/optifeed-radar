/**
 * Shared HTTP for engine adapters (M6): POST JSON with exponential backoff on
 * 429/5xx and a timeout. Injectable `httpPost` and `sleep` so retry/backoff
 * paths test without network or real delays.
 */

export interface HttpJsonResponse {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type HttpPost = (
  url: string,
  init: { headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<HttpJsonResponse>;

/** A non-2xx HTTP response that is not (or no longer) retryable. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Real HTTP POST over the global fetch; the default for production use. */
export const defaultHttpPost: HttpPost = async (url, init) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return {
    status: res.status,
    json: () => res.json(),
    text: () => res.text(),
  };
};

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Real provider error bodies are pretty-printed multi-line JSON, not the short
 * synthetic strings unit tests used before this was measured against a live
 * call. OpenAI's exhausted-credit 429, for example, is:
 *
 *   {
 *       "error": {
 *           "message": "You have no credits remaining. Add credits to
 *           continue using the API at https://platform.openai.com/...",
 *           "type": "insufficient_quota",
 *           "param": null,
 *           "code": "credit_balance_exhausted"
 *       }
 *   }
 *
 * Thrown verbatim, that newline-and-indentation whitespace lands in a user's
 * terminal, MCP output, and persisted notes, and an unusually verbose
 * provider could dump kilobytes with no bound at all.
 *
 * This codebase talks to four providers with four different error envelopes
 * (CLAUDE.md M0-M6 lesson #4: parse every real data shape, not just the
 * canonical one). A blind prefix-slice of the whole body is tuned to whichever
 * provider happens to put `message` first - OpenAI does, but Anthropic and
 * Gemini both put other fields first:
 *
 *   Anthropic (`/v1/messages`, docs.anthropic.com/en/api/errors):
 *     {"type":"error","error":{"type":"rate_limit_error","message":"..."}}
 *   Gemini (`generateContent`, Google's standard `google.rpc.Status` shape):
 *     {"error":{"code":429,"message":"...","status":"RESOURCE_EXHAUSTED"}}
 *
 * For either, a position-based cut keeps the boilerplate `type`/`code` field
 * and can cut the actionable sentence entirely once it runs past the cap. So
 * `summarizeErrorBody` parses the body as JSON first and reads `error.message`
 * (OpenAI, Anthropic, Gemini, and Perplexity's OpenAI-compatible
 * `/chat/completions` errors all nest it there) or a flat `message`/`detail`
 * (seen from auth gateways that reject before reaching the provider's own
 * handler) - a keyed lookup, so field ORDER cannot lose the message. Only a
 * body that is not JSON, or JSON with none of those fields, falls back to the
 * blind whitespace-collapse-and-slice below.
 */
const STRUCTURED_MESSAGE_MAX_CHARS = 350;

/**
 * The fallback cap for a raw (non-JSON, or unrecognized-shape) body: an HTML
 * error page from a gateway, or a plain-text response. 200 chars was the
 * original cap chosen against OpenAI's full pretty-printed body (see the git
 * history of this constant); kept here for the no-structured-message case,
 * where there is no semantically-tagged field to trust, so bounding the whole
 * blob short is the safer default.
 */
const RAW_BODY_MAX_CHARS = 200;

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** What a redacted key is replaced with - a marker, never silence. */
const REDACTED_KEY = '[redacted API key]';

/**
 * Recognizable API-key shapes, stripped from every provider error body.
 *
 * Providers echo the credential they received back into the message they
 * return: OpenAI's 401 reads "Incorrect API key provided: sk-proj-a1B2c3***...".
 * That text does not stop at the terminal - it reaches
 * `honesty.skippedEngines[].reason` on a check envelope and `notes[]` on a
 * shopping envelope, both of which are PERSISTED to disk as JSON. Hard rule #4
 * is "never log or persist API keys", and `summarizeErrorBody` is the single
 * chokepoint all four providers' error bodies pass through, so the redaction
 * lives here rather than in four adapters.
 *
 * What is echoed is normally a provider-MASKED fragment, not a live key, which
 * is why this is hardening rather than a leak fix - and also why the match must
 * tolerate the mask: `*` is in the character class because OpenAI replaces the
 * middle of the key with asterisks.
 *
 * Deliberately NOT a generic "long opaque token" pattern: model ids
 * (`gpt-5.4-mini-2026-01-01`), request ids (`req_...`) and org ids travel in
 * these same messages and are what makes a failure diagnosable. Redacting them
 * would cost real debuggability to guard against a shape no provider uses.
 */
const API_KEY_PATTERNS: RegExp[] = [
  // OpenAI (`sk-...`, `sk-proj-...`), Anthropic (`sk-ant-...`), and
  // Perplexity, whose keys use the same prefix.
  /sk-[A-Za-z0-9_*-]+/g,
  // Google AI Studio / Gemini keys, which a 400 echoes whole.
  /AIza[A-Za-z0-9_*-]+/g,
];

/**
 * Replace any recognizable key material in `s` with {@link REDACTED_KEY}.
 *
 * Applied BEFORE the length cap, so a key sitting on the truncation boundary
 * cannot survive as a half-key fragment.
 */
function redactKeys(s: string): string {
  return API_KEY_PATTERNS.reduce(
    (out, pattern) => out.replace(pattern, REDACTED_KEY),
    s,
  );
}

/**
 * `String.prototype.slice` cuts by UTF-16 code unit. A cut that lands between
 * a surrogate pair's two halves (e.g. inside an emoji in a provider's message)
 * leaves an unpaired trailing surrogate, which is invalid UTF-16 on its own.
 * Low blast radius - provider error text is almost always ASCII - but it is a
 * one-line guard: drop a trailing lone high surrogate rather than emit it.
 */
function sliceSafely(s: string, max: number): string {
  const cut = s.slice(0, max);
  const lastCode = cut.charCodeAt(cut.length - 1);
  const isLoneHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return isLoneHighSurrogate ? cut.slice(0, -1) : cut;
}

function capWithMarker(s: string, max: number): string {
  return s.length > max ? `${sliceSafely(s, max)}... [truncated]` : s;
}

/**
 * Pull the human-readable message out of a parsed provider error body,
 * whatever field it is nested under - see the shapes documented above
 * `STRUCTURED_MESSAGE_MAX_CHARS`. Returns undefined when nothing recognizable
 * is present, so the caller can fall back to the raw-body path.
 */
function extractStructuredMessage(parsedBody: unknown): string | undefined {
  if (typeof parsedBody !== 'object' || parsedBody === null) return undefined;
  const obj = parsedBody as Record<string, unknown>;

  const nestedError = obj.error;
  if (typeof nestedError === 'object' && nestedError !== null) {
    const nestedMessage = (nestedError as Record<string, unknown>).message;
    if (typeof nestedMessage === 'string' && nestedMessage.trim() !== '') {
      return nestedMessage;
    }
  }
  if (typeof obj.message === 'string' && obj.message.trim() !== '') {
    return obj.message;
  }
  // FastAPI-style gateways (seen in front of some provider APIs for
  // auth/validation rejections) report a flat `detail` string instead.
  if (typeof obj.detail === 'string' && obj.detail.trim() !== '') {
    return obj.detail;
  }
  return undefined;
}

function summarizeErrorBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed !== '') {
    let structuredMessage: string | undefined;
    try {
      structuredMessage = extractStructuredMessage(JSON.parse(trimmed));
    } catch {
      structuredMessage = undefined; // not JSON - fall through to raw below
    }
    if (structuredMessage !== undefined) {
      return capWithMarker(
        redactKeys(collapseWhitespace(structuredMessage)),
        STRUCTURED_MESSAGE_MAX_CHARS,
      );
    }
  }
  return capWithMarker(
    redactKeys(collapseWhitespace(trimmed)),
    RAW_BODY_MAX_CHARS,
  );
}

async function withTimeout<T>(
  run: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> {
  if (!timeoutMs) return run(undefined);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function postJsonWithRetry(
  httpPost: HttpPost,
  url: string,
  init: { headers: Record<string, string>; body: string },
  opts: RetryOptions = {},
): Promise<unknown> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const sleep = opts.sleep ?? realSleep;

  for (let attempt = 0; ; attempt++) {
    let res: HttpJsonResponse;
    try {
      res = await withTimeout(
        (signal) => httpPost(url, { ...init, signal }),
        opts.timeoutMs,
      );
    } catch (err) {
      if (attempt < retries) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }

    if (res.status >= 200 && res.status < 300) {
      try {
        return await res.json();
      } catch {
        // A 2xx with a non-JSON body (captive portal, gateway page): wrap it
        // so callers get a graceful HttpError, never a raw SyntaxError.
        throw new HttpError(
          res.status,
          `HTTP ${res.status}: non-JSON response body`,
        );
      }
    }

    if (isRetryableStatus(res.status) && attempt < retries) {
      await sleep(baseDelayMs * 2 ** attempt);
      continue;
    }

    const body = await res.text().catch(() => '');
    throw new HttpError(
      res.status,
      `HTTP ${res.status}: ${summarizeErrorBody(body)}`.trim(),
    );
  }
}
