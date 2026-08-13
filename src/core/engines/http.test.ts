import { describe, expect, it, vi } from 'vitest';
import { HttpError, type HttpPost, postJsonWithRetry } from './http.js';

function response(status: number, body: unknown) {
  return {
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const noSleep = async () => {};

describe('postJsonWithRetry', () => {
  it('returns parsed JSON on a 2xx', async () => {
    const post: HttpPost = vi.fn(async () => response(200, { ok: 1 }));
    const out = await postJsonWithRetry(
      post,
      'https://x',
      { headers: {}, body: '{}' },
      { sleep: noSleep },
    );
    expect(out).toEqual({ ok: 1 });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and then succeeds', async () => {
    const post: HttpPost = vi
      .fn()
      .mockResolvedValueOnce(response(429, 'slow down'))
      .mockResolvedValueOnce(response(200, { ok: 1 }));
    const out = await postJsonWithRetry(
      post,
      'https://x',
      { headers: {}, body: '{}' },
      { sleep: noSleep },
    );
    expect(out).toEqual({ ok: 1 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('retries 5xx up to the limit then throws HttpError', async () => {
    const post: HttpPost = vi.fn(async () => response(503, 'unavailable'));
    await expect(
      postJsonWithRetry(
        post,
        'https://x',
        { headers: {}, body: '{}' },
        { retries: 2, sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(post).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does not retry a 400', async () => {
    const post: HttpPost = vi.fn(async () => response(400, 'bad request'));
    await expect(
      postJsonWithRetry(
        post,
        'https://x',
        { headers: {}, body: '{}' },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially between retries', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    const post: HttpPost = vi
      .fn()
      .mockResolvedValueOnce(response(500, 'x'))
      .mockResolvedValueOnce(response(500, 'x'))
      .mockResolvedValueOnce(response(200, { ok: 1 }));
    await postJsonWithRetry(
      post,
      'https://x',
      { headers: {}, body: '{}' },
      { baseDelayMs: 100, sleep },
    );
    expect(delays).toEqual([100, 200]);
  });

  // A real provider error body, not a short synthetic string - this is the
  // actual pretty-printed JSON OpenAI returns for an exhausted-credit 429
  // (M8-review lesson 1: mocks must mirror real response shapes).
  const REAL_OPENAI_QUOTA_BODY = `{
    "error": {
        "message": "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
        "type": "insufficient_quota",
        "param": null,
        "code": "credit_balance_exhausted"
    }
}`;

  it('collapses a multi-line provider error body onto one line and caps its length', async () => {
    const post: HttpPost = vi.fn(async () =>
      response(429, REAL_OPENAI_QUOTA_BODY),
    );

    let status = 0;
    let message = '';
    try {
      await postJsonWithRetry(
        post,
        'https://x',
        { headers: {}, body: '{}' },
        { retries: 0, sleep: noSleep },
      );
    } catch (err) {
      status = err instanceof HttpError ? err.status : 0;
      message = err instanceof Error ? err.message : String(err);
    }

    expect(status).toBe(429);
    // The actionable sentence survives the cap.
    expect(message).toContain('You have no credits remaining');
    // No raw newlines or indentation from the pretty-printed body.
    expect(message).not.toContain('\n');
    expect(message).not.toContain('    ');
    // Bounded length even though the source body plus the "HTTP 429: " prefix
    // is longer than that - a verbose provider must never dump unbounded text.
    expect(message.length).toBeLessThan(230);
  });

  it('bounds an unusually long provider error message with a truncation marker', async () => {
    const hugeBody = JSON.stringify({
      error: { message: 'x'.repeat(5000), type: 'server_error' },
    });
    const post: HttpPost = vi.fn(async () => response(500, hugeBody));
    let message = '';
    try {
      await postJsonWithRetry(
        post,
        'https://x',
        { headers: {}, body: '{}' },
        { retries: 0, sleep: noSleep },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // Well under the 5000-char source message: the structured-message cap
    // (350) plus the "HTTP 500: " prefix and "... [truncated]" marker.
    expect(message.length).toBeLessThan(400);
    expect(message).toMatch(/truncated/i);
  });

  // Anthropic's documented error envelope (docs.anthropic.com/en/api/errors):
  // the nested object's OWN `type` field precedes `message`, and this is
  // pretty-printed like a real HTTP body (4-space indent), same as the real
  // OpenAI fixture above. The message itself is long enough that its tail -
  // "...organization workspace tier." - lands past character 200 of the
  // whitespace-collapsed body: a position-based 200-char slice truncates
  // before reaching it (verified against the pre-fix implementation), while
  // a keyed `error.message` lookup does not care where in the body it sits.
  const ANTHROPIC_RATE_LIMIT_BODY = `{
    "type": "error",
    "error": {
        "type": "rate_limit_error",
        "message": "Number of request tokens has exceeded your per-minute rate limit. See https://docs.anthropic.com/en/api/rate-limits for your current limits, or contact sales to request an increase for your organization workspace tier."
    }
}`;

  it('extracts the message from an Anthropic-shaped body where message is NOT the first field', async () => {
    const post: HttpPost = vi.fn(async () =>
      response(429, ANTHROPIC_RATE_LIMIT_BODY),
    );
    let message = '';
    try {
      await postJsonWithRetry(
        post,
        'https://x',
        { headers: {}, body: '{}' },
        { retries: 0, sleep: noSleep },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(
      'Number of request tokens has exceeded your per-minute rate limit',
    );
    // Past character 200 of the raw body - only reached via structured
    // extraction, never via a blind 200-char prefix slice.
    expect(message).toContain(
      'contact sales to request an increase for your organization workspace tier',
    );
  });

  // Gemini's documented error envelope (Google's standard `google.rpc.Status`
  // shape, shared across Google APIs): `code` precedes `message`, same
  // ordering hazard as Anthropic above, and the message's tail similarly
  // lands past character 200 of the collapsed body.
  const GEMINI_QUOTA_BODY = `{
    "error": {
        "code": 429,
        "message": "Resource has been exhausted (e.g. check quota). Retry after a short delay, or request a quota increase at https://ai.google.dev/gemini-api/docs/rate-limits for the model your project is using.",
        "status": "RESOURCE_EXHAUSTED"
    }
}`;

  it('extracts the message from a Gemini-shaped body where message is NOT the first field', async () => {
    const post: HttpPost = vi.fn(async () => response(429, GEMINI_QUOTA_BODY));
    let message = '';
    try {
      await postJsonWithRetry(
        post,
        'https://x',
        { headers: {}, body: '{}' },
        { retries: 0, sleep: noSleep },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(
      'Resource has been exhausted (e.g. check quota).',
    );
    // Past character 200 of the raw body - only reached via structured
    // extraction, never via a blind 200-char prefix slice.
    expect(message).toContain('the model your project is using');
  });

  // Perplexity's `/chat/completions` is OpenAI-compatible, including its
  // error envelope.
  const PERPLEXITY_INVALID_REQUEST_BODY = JSON.stringify({
    error: {
      message: 'Invalid model specified: sonar-xl-does-not-exist.',
      type: 'invalid_request_error',
      code: null,
    },
  });

  it('extracts the message from a Perplexity-shaped (OpenAI-compatible) body', async () => {
    const post: HttpPost = vi.fn(async () =>
      response(400, PERPLEXITY_INVALID_REQUEST_BODY),
    );
    let message = '';
    try {
      await postJsonWithRetry(
        post,
        'https://x',
        { headers: {}, body: '{}' },
        { retries: 0, sleep: noSleep },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('Invalid model specified');
  });

  // A FastAPI-style auth gateway some providers sit behind a flat `detail`
  // string, not a nested `error.message` - a different field name entirely.
  const GATEWAY_AUTH_REJECTION_BODY = JSON.stringify({
    detail: 'Invalid API key provided.',
  });

  it('falls back to a flat `detail` field when there is no nested error.message', async () => {
    const post: HttpPost = vi.fn(async () =>
      response(401, GATEWAY_AUTH_REJECTION_BODY),
    );
    let message = '';
    try {
      await postJsonWithRetry(
        post,
        'https://x',
        { headers: {}, body: '{}' },
        { retries: 0, sleep: noSleep },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('Invalid API key provided.');
  });

  // A gateway/proxy error is not always JSON at all - an nginx or Cloudflare
  // 502 page is HTML. `JSON.parse` throws, so this must fall back to the
  // blind whitespace-collapse-and-slice path, not lose the body entirely.
  const HTML_GATEWAY_ERROR_BODY =
    '<html>\n  <head><title>502 Bad Gateway</title></head>\n' +
    '  <body>\n    <center><h1>502 Bad Gateway</h1></center>\n' +
    '    <hr><center>nginx</center>\n  </body>\n</html>\n';

  it('falls back to whitespace-collapsed slicing for a non-JSON (HTML) error body', async () => {
    const post: HttpPost = vi.fn(async () =>
      response(502, HTML_GATEWAY_ERROR_BODY),
    );
    let message = '';
    try {
      await postJsonWithRetry(
        post,
        'https://x',
        { headers: {}, body: '{}' },
        { retries: 0, sleep: noSleep },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('502 Bad Gateway');
    expect(message).not.toContain('\n');
  });

  /** True if `s` contains a surrogate half with no matching partner. */
  function hasLoneSurrogate(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = s.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        i++; // consumed a valid pair
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true; // lone low surrogate
      }
    }
    return false;
  }

  it('never emits an unpaired surrogate when a truncation cut lands inside one', async () => {
    // Built so the 350-char structured-message cap lands exactly between the
    // two UTF-16 code units of the rocket emoji (a surrogate pair).
    const message = `${'a'.repeat(349)}\u{1F680}${'b'.repeat(50)}`;
    const body = JSON.stringify({ error: { message } });
    const post: HttpPost = vi.fn(async () => response(500, body));
    let out = '';
    try {
      await postJsonWithRetry(
        post,
        'https://x',
        { headers: {}, body: '{}' },
        { retries: 0, sleep: noSleep },
      );
    } catch (err) {
      out = err instanceof Error ? err.message : String(err);
    }
    expect(hasLoneSurrogate(out)).toBe(false);
  });
});
