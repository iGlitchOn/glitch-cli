export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  abortSignal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object') {
    const rec = error as Record<string, unknown>;
    if (rec['name'] === 'AbortError' || rec['code'] === 'ABORT_ERR') {
      return true;
    }
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /abort|cancelado por el usuario/i.test(msg);
}

export function isTransientError(error: unknown): boolean {
  if (!error) return false;
  if (isAbortError(error)) return false;

  if (typeof error === 'object') {
    const errRecord = error as Record<string, unknown>;
    const status =
      typeof errRecord['status'] === 'number'
        ? errRecord['status']
        : typeof errRecord['statusCode'] === 'number'
          ? errRecord['statusCode']
          : undefined;

    if (status !== undefined) {
      if (TRANSIENT_HTTP_STATUSES.has(status)) {
        return true;
      }
      if (status >= 400 && status < 500) {
        return false;
      }
    }

    const code =
      typeof errRecord['code'] === 'string' ? errRecord['code'] : undefined;
    if (code && NETWORK_ERROR_CODES.has(code)) {
      return true;
    }

    if (errRecord['cause'] && isTransientError(errRecord['cause'])) {
      return true;
    }
  }

  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes('429') ||
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('resource_exhausted') ||
    lower.includes('too many requests') ||
    lower.includes('rate limit') ||
    lower.includes('internal error') ||
    lower.includes('service unavailable') ||
    lower.includes('bad gateway') ||
    lower.includes('gateway timeout')
  ) {
    return true;
  }

  if (
    lower.includes('fetch failed sending request') ||
    lower.includes('typeerror: fetch failed') ||
    lower.includes('fetch failed') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('eai_again') ||
    lower.includes('und_err_socket') ||
    lower.includes('und_err_connect_timeout') ||
    lower.includes('und_err_headers_timeout') ||
    lower.includes('und_err_body_timeout') ||
    lower.includes('network error') ||
    lower.includes('socket hang up') ||
    lower.includes('epipe') ||
    lower.includes('terminated')
  ) {
    return true;
  }

  return false;
}

export const isRetryableRequestError = isTransientError;

function sleepWithAbort(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted) {
    return Promise.reject(new Error('Cancelado por el usuario (ESC).'));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Cancelado por el usuario (ESC).'));
    };
    const timer = setTimeout(() => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, delayMs);
    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 9;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const abortSignal = options.abortSignal;

  let attempt = 0;
  while (true) {
    if (abortSignal?.aborted) {
      throw new Error('Cancelado por el usuario (ESC).');
    }
    try {
      return await operation(attempt);
    } catch (error) {
      if (
        abortSignal?.aborted ||
        attempt >= maxRetries ||
        !isTransientError(error)
      ) {
        throw error;
      }
      attempt++;
      const expDelay = Math.min(
        maxDelayMs,
        baseDelayMs * Math.pow(2, attempt - 1),
      );
      const jitter =
        jitterRatio > 0 ? expDelay * jitterRatio * Math.random() : 0;
      const delayMs = Math.max(1, Math.round(expDelay + jitter));
      options.onRetry?.(attempt, delayMs, error);
      await sleepWithAbort(delayMs, abortSignal);
    }
  }
}

export const withRetryBackoff = withRetry;
