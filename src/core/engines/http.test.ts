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

  it('bounds an unusually long provider error body with a truncation marker', async () => {
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
    expect(message.length).toBeLessThan(230);
    expect(message).toMatch(/truncated/i);
  });
});
