import {
  GoogleGenAI,
  type Content,
  type GenerateContentConfig,
  type Part,
} from '@google/genai';
import { buildVertexThinkingConfig } from '../config/models.js';
import type { EffortLevel, VertexConfig } from '../config/settings.js';
import { normalizeHistoryForVertex } from '../core/history.js';
import { withRetryBackoff, type RetryOptions } from '../core/retry.js';
import type {
  ProviderAdapter,
  ProviderRequestOptions,
  ProviderStreamChunk,
} from './types.js';

export function createVertexGenAI(config: VertexConfig): GoogleGenAI {
  if (!config.project?.trim()) {
    throw new Error('Falta GOOGLE_CLOUD_PROJECT para inicializar Vertex AI.');
  }
  if (!config.location?.trim()) {
    throw new Error('Falta GOOGLE_CLOUD_LOCATION para inicializar Vertex AI.');
  }

  process.env['GOOGLE_CLOUD_PROJECT'] = config.project.trim();
  process.env['GOOGLE_CLOUD_LOCATION'] = config.location.trim();
  delete process.env['GOOGLE_API_KEY'];
  delete process.env['GEMINI_API_KEY'];

  return new GoogleGenAI({
    vertexai: true,
    project: config.project.trim(),
    location: config.location.trim(),
  });
}

export interface VertexStreamOptions {
  effort?: EffortLevel;
  includeThoughts?: boolean;
  abortSignal?: AbortSignal;
  onParts?: (parts: Part[]) => void;
  retryOptions?: RetryOptions;
}

export class VertexProviderAdapter implements ProviderAdapter {
  readonly id = 'vertex';

  constructor(
    private readonly ai: GoogleGenAI,
    private readonly retryOptions: RetryOptions = {},
  ) {}

  async *streamTurn(
    history: readonly Content[],
    options: ProviderRequestOptions,
  ): AsyncGenerator<ProviderStreamChunk, void, unknown> {
    const thinkingConfig = buildVertexThinkingConfig(
      options.model,
      options.effort,
      options.includeThoughts,
    );

    const config: GenerateContentConfig = {};
    if (thinkingConfig) {
      config.thinkingConfig = thinkingConfig;
    }
    if (options.abortSignal) {
      config.abortSignal = options.abortSignal;
    }

    // Regla anti-400 de Vertex ejecutada tanto en la llamada inicial como en cada reintento
    const responseStream = await withRetryBackoff(async () => {
      const normalizedContents = normalizeHistoryForVertex(history);
      return await this.ai.models.generateContentStream({
        model: options.model,
        contents: normalizedContents,
        config,
      });
    }, this.retryOptions);

    for await (const chunk of responseStream) {
      const rawParts = chunk.candidates?.[0]?.content?.parts;
      const clonedParts = rawParts
        ? rawParts.map((part) => ({ ...part }))
        : undefined;

      let thoughtText: string | undefined;
      let visibleText = '';

      if (clonedParts && clonedParts.length > 0) {
        for (const p of clonedParts) {
          const isThought = Boolean((p as Record<string, unknown>)['thought']);
          if (isThought && p.text) {
            thoughtText = (thoughtText ?? '') + p.text;
          } else if (!isThought && p.text) {
            visibleText += p.text;
          }
        }
      } else if (chunk.text) {
        visibleText = chunk.text;
      }

      yield {
        text: visibleText || undefined,
        thoughtText: options.includeThoughts ? thoughtText : undefined,
        rawParts: clonedParts,
      };
    }
  }
}

export async function* streamVertexChat(
  ai: GoogleGenAI,
  model: string,
  contents: Content[],
  options: VertexStreamOptions = {},
): AsyncGenerator<string, void, unknown> {
  const adapter = new VertexProviderAdapter(ai, options.retryOptions);
  for await (const chunk of adapter.streamTurn(contents, {
    model,
    effort: options.effort ?? 'medium',
    includeThoughts: options.includeThoughts ?? true,
    subMode: 'agent',
    abortSignal: options.abortSignal,
  })) {
    if (chunk.rawParts && options.onParts) {
      options.onParts(chunk.rawParts);
    }
    if (chunk.text) {
      yield chunk.text;
    }
  }
}
