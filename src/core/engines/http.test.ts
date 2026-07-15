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
});
