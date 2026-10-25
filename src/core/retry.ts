export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function isRetryableRequestError(error: unknown): boolean {
  if (!error) return false;

  if (typeof error === 'object') {
    const errRecord = error as Record<string, unknown>;
    const status =
      typeof errRecord['status'] === 'number'
        ? errRecord['status']
        : typeof errRecord['statusCode'] === 'number'
          ? errRecord['statusCode']
          : undefined;

    if (status === 429) {
      return true;
    }
    if (status !== undefined && status >= 400 && status < 500) {
      return false;
    }

    const code =
      typeof errRecord['code'] === 'string' ? errRecord['code'] : undefined;
    if (code && NETWORK_ERROR_CODES.has(code)) {
      return true;
    }
  }

  const message =
    error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('too many requests') ||
    lower.includes('rate limit')
  ) {
    return true;
  }

  if (
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('fetch failed') ||
    lower.includes('network error') ||
    lower.includes('socket hang up')
  ) {
    return true;
  }

  return false;
}

/**
 * Ejecuta una operación asíncrona con hasta maxRetries (por defecto 3) reintentos
 * y backoff exponencial únicamente para HTTP 429 y errores de red.
 */
export async function withRetryBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;

  let attempt = 0;
  while (true) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableRequestError(error)) {
        throw error;
      }
      attempt++;
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      options.onRetry?.(attempt, delayMs, error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
