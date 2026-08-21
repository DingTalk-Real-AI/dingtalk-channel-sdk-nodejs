import { ChannelError, classifyError, isRetryable } from '../errors.js';

export class RetryOptions {
  constructor({ maxAttempts = 3, baseDelayMs = 500 } = {}) {
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
  }
}

export async function retry(op, opts) {
  const o = opts ?? new RetryOptions();
  const maxAttempts = o.maxAttempts ?? 3;
  const baseDelayMs = o.baseDelayMs ?? 500;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const classified =
        err instanceof ChannelError ? err : classifyError(err);
      if (attempt >= maxAttempts || !isRetryable(classified)) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(3, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
