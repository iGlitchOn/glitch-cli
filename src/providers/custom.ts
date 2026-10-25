import type { Content } from '@google/genai';
import {
  maskApiKey,
  type CustomApiConfig,
  type EffortLevel,
} from '../config/settings.js';
import { withRetryBackoff, type RetryOptions } from '../core/retry.js';
import type {
  ProviderAdapter,
  ProviderRequestOptions,
  ProviderStreamChunk,
} from './types.js';

export type FetchLike = typeof fetch;

export function buildEndpointUrl(
  baseUrl: string,
  format: CustomApiConfig['format'],
): string {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  if (
    clean.endsWith('/v1/chat/completions') ||
    clean.endsWith('/v1/responses')
  ) {
    return clean;
  }
  const suffix =
    format === 'responses' ? '/v1/responses' : '/v1/chat/completions';
  if (clean.endsWith('/v1')) {
    return `${clean.slice(0, -3)}${suffix}`;
  }
  return `${clean}${suffix}`;
}

export function buildCustomRequestBody(
  config: CustomApiConfig,
  history: readonly Content[],
  options: ProviderRequestOptions,
  supportsReasoningEffort = true,
): Record<string, unknown> {
  const messages = history.map((turn) => {
    const role = turn.role === 'model' ? 'assistant' : 'user';
    const content = (turn.parts ?? [])
      .filter((p) => !(p as Record<string, unknown>)['thought'])
      .map((p) => p.text ?? '')
      .join('');
    return { role, content };
  });

  if (config.format === 'responses') {
    const payload: Record<string, unknown> = {
      model: options.model,
      input: messages,
      stream: false,
    };
    if (supportsReasoningEffort) {
      payload['reasoning'] = { effort: options.effort };
    }
    return payload;
  }

  const payload: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: false,
  };
  if (supportsReasoningEffort) {
    payload['reasoning_effort'] = options.effort as EffortLevel;
  }
  return payload;
}

export function sanitizeSecretFromError(
  message: string,
  apiKey: string,
): string {
  if (!apiKey || !message.includes(apiKey)) {
    return message;
  }
  return message.split(apiKey).join(maskApiKey(apiKey));
}

export class CustomProviderAdapter implements ProviderAdapter {
  readonly id = 'custom';

  constructor(
    private readonly config: CustomApiConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly retryOptions: RetryOptions = {},
    private readonly supportsReasoningEffort: boolean = true,
  ) {}

  async *streamTurn(
    history: readonly Content[],
    options: ProviderRequestOptions,
  ): AsyncGenerator<ProviderStreamChunk, void, unknown> {
    const url = buildEndpointUrl(this.config.baseUrl, this.config.format);
    const body = buildCustomRequestBody(
      this.config,
      history,
      options,
      this.supportsReasoningEffort,
    );

    const jsonData = await withRetryBackoff(async () => {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: options.abortSignal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(sanitizeSecretFromError(msg, this.config.apiKey));
      }

      if (!res.ok) {
        const rawErrText = await res.text().catch(() => '');
        const safeText = sanitizeSecretFromError(
          rawErrText || res.statusText,
          this.config.apiKey,
        );
        const httpErr = new Error(
          `HTTP ${res.status} en API personalizada: ${safeText}`,
        ) as Error & { status?: number };
        httpErr.status = res.status;
        throw httpErr;
      }

      return (await res.json()) as Record<string, unknown>;
    }, this.retryOptions);

    if (this.config.format === 'responses') {
      const outputText =
        typeof jsonData['output_text'] === 'string'
          ? jsonData['output_text']
          : extractResponsesOutputText(jsonData);
      if (outputText) {
        yield {
          text: outputText,
          rawParts: [{ text: outputText }],
        };
      }
      return;
    }

    const choices = Array.isArray(jsonData['choices'])
      ? (jsonData['choices'] as Array<Record<string, unknown>>)
      : [];
    const firstMessage = choices[0]?.['message'] as
      | Record<string, unknown>
      | undefined;
    const text =
      typeof firstMessage?.['content'] === 'string'
        ? firstMessage['content']
        : '';
    const reasoning =
      typeof firstMessage?.['reasoning_content'] === 'string'
        ? firstMessage['reasoning_content']
        : undefined;

    if (reasoning && options.includeThoughts) {
      yield {
        thoughtText: reasoning,
        rawParts: [{ text: reasoning, thought: true }],
      };
    }

    if (text) {
      yield {
        text,
        rawParts: [{ text }],
      };
    }
  }
}

function extractResponsesOutputText(data: Record<string, unknown>): string {
  const output = Array.isArray(data['output'])
    ? (data['output'] as Array<Record<string, unknown>>)
    : [];
  const texts: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item['content'])
      ? (item['content'] as Array<Record<string, unknown>>)
      : [];
    for (const part of content) {
      if (typeof part['text'] === 'string') {
        texts.push(part['text']);
      }
    }
  }
  return texts.join('');
}
