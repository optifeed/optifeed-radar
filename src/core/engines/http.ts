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
    throw new HttpError(res.status, `HTTP ${res.status}: ${body}`.trim());
  }
}
