import {
  GoogleGenAI,
  type Content,
  type CountTokensConfig,
  type GenerateContentConfig,
  type Part,
} from '@google/genai';
import {
  buildVertexThinkingConfig,
  recordApiRequestDebugLog,
  resolveEffectiveEffortForModel,
} from '../config/models.js';
import type { EffortLevel, VertexConfig } from '../config/settings.js';
import { normalizeHistoryForVertex } from '../core/history.js';
import { withRetry, type RetryOptions } from '../core/retry.js';
import { GLITCH_TOOL_DECLARATIONS } from '../core/tools.js';
import type {
  ApiTokenUsage,
  ProviderAdapter,
  ProviderRequestOptions,
  ProviderStreamChunk,
  RawApiUsageMetadata,
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
    let lastSentIncludeThoughts = options.includeThoughts;

    // Construir configuración y parámetros (thinkingLevel, model, subMode) en el momento exacto de cada petición y reintento
    const responseStream = await withRetry(
      async () => {
        const liveOpts = options.getLiveOptions
          ? options.getLiveOptions()
          : options;
        lastSentIncludeThoughts = liveOpts.includeThoughts;

        const { effectiveEffort, supported } = resolveEffectiveEffortForModel(
          liveOpts.model,
          liveOpts.effort,
          'vertex',
        );
        const thinkingConfig = buildVertexThinkingConfig(
          liveOpts.model,
          effectiveEffort,
          liveOpts.includeThoughts,
        );

        const config: GenerateContentConfig = {};
        if (thinkingConfig) {
          config.thinkingConfig = thinkingConfig;
        }
        if (liveOpts.abortSignal ?? options.abortSignal) {
          config.abortSignal = liveOpts.abortSignal ?? options.abortSignal;
        }
        if (liveOpts.systemInstruction) {
          config.systemInstruction = liveOpts.systemInstruction;
        }
        if (liveOpts.enableTools) {
          config.tools = [{ functionDeclarations: GLITCH_TOOL_DECLARATIONS }];
        }

        const thinkingParamStr = thinkingConfig?.thinkingLevel
          ? `thinkingLevel=${String(thinkingConfig.thinkingLevel)}`
          : supported
            ? `thinkingLevel=${effectiveEffort.toUpperCase()}`
            : 'thinkingLevel=N/A';

        recordApiRequestDebugLog({
          provider: 'vertex',
          model: liveOpts.model,
          effort: effectiveEffort,
          thinkingParameter: thinkingParamStr,
          subMode: liveOpts.subMode,
          includeThoughts: liveOpts.includeThoughts,
        });

        const normalizedContents = normalizeHistoryForVertex(history);
        return await this.ai.models.generateContentStream({
          model: liveOpts.model,
          contents: normalizedContents,
          config,
        });
      },
      {
        maxRetries: 9,
        baseDelayMs: 600,
        ...this.retryOptions,
      },
    );

    for await (const chunk of responseStream) {
      const rawParts = chunk.candidates?.[0]?.content?.parts;
      const clonedParts = rawParts
        ? rawParts.map((part) => ({ ...part }))
        : undefined;

      let thoughtText: string | undefined;
      let visibleText = '';

      if (clonedParts && clonedParts.length > 0) {
        for (const p of clonedParts) {
          const partRec = p as Record<string, unknown>;
          const partType =
            typeof partRec['type'] === 'string'
              ? partRec['type'].toLowerCase()
              : '';
          const isThought =
            Boolean(partRec['thought']) ||
            partType === 'thinking' ||
            partType === 'reasoning' ||
            typeof partRec['thinking'] === 'string' ||
            typeof partRec['reasoning'] === 'string';
          const extractedThought =
            p.text ??
            (typeof partRec['thinking'] === 'string'
              ? partRec['thinking']
              : typeof partRec['reasoning'] === 'string'
                ? partRec['reasoning']
                : undefined);
          if (isThought && extractedThought) {
            thoughtText = (thoughtText ?? '') + extractedThought;
          } else if (!isThought && p.text) {
            visibleText += p.text;
          }
        }
      } else if (chunk.text) {
        visibleText = chunk.text;
      }

      let usage: ApiTokenUsage | undefined;
      const meta = (chunk as unknown as Record<string, unknown>)[
        'usageMetadata'
      ] as Record<string, unknown> | undefined;
      if (meta && typeof meta === 'object') {
        const rawMetadata: RawApiUsageMetadata = {
          promptTokenCount:
            typeof meta['promptTokenCount'] === 'number'
              ? meta['promptTokenCount']
              : null,
          candidatesTokenCount:
            typeof meta['candidatesTokenCount'] === 'number'
              ? meta['candidatesTokenCount']
              : null,
          cachedContentTokenCount:
            typeof meta['cachedContentTokenCount'] === 'number'
              ? meta['cachedContentTokenCount']
              : null,
          thoughtsTokenCount:
            typeof meta['thoughtsTokenCount'] === 'number'
              ? meta['thoughtsTokenCount']
              : null,
          toolUsePromptTokenCount:
            typeof meta['toolUsePromptTokenCount'] === 'number'
              ? meta['toolUsePromptTokenCount']
              : null,
          totalTokenCount:
            typeof meta['totalTokenCount'] === 'number'
              ? meta['totalTokenCount']
              : null,
        };

        const hasAnyReportedField = Object.values(rawMetadata).some(
          (v) => typeof v === 'number',
        );
        if (hasAnyReportedField) {
          const promptTokens = rawMetadata.promptTokenCount ?? 0;
          const toolUseTokens = rawMetadata.toolUsePromptTokenCount ?? 0;
          const cachedTokens = rawMetadata.cachedContentTokenCount ?? 0;
          const candidatesTokens = rawMetadata.candidatesTokenCount ?? 0;
          const thoughtsTokens = rawMetadata.thoughtsTokenCount ?? 0;
          const totalTokens = rawMetadata.totalTokenCount ?? 0;

          const toolTokensAreSeparate =
            toolUseTokens > 0 &&
            totalTokens > 0 &&
            promptTokens + toolUseTokens + candidatesTokens + thoughtsTokens ===
              totalTokens;
          const totalPromptTokens =
            promptTokens + (toolTokensAreSeparate ? toolUseTokens : 0);

          usage = {
            inputTokens: Math.max(0, totalPromptTokens - cachedTokens),
            outputTokens: Math.max(0, candidatesTokens),
            cachedTokens: Math.max(0, cachedTokens),
            reasoningTokens: Math.max(0, thoughtsTokens),
            toolUsePromptTokens: Math.max(0, toolUseTokens),
            totalPromptTokens: Math.max(0, totalPromptTokens),
            rawMetadata,
          };
        }
      }

      yield {
        text: visibleText || undefined,
        thoughtText: lastSentIncludeThoughts ? thoughtText : undefined,
        rawParts: clonedParts,
        usage,
      };
    }
  }

  async countTokens(
    history: readonly Content[],
    options: ProviderRequestOptions,
  ): Promise<number | null> {
    try {
      const normalizedContents =
        history.length > 0
          ? normalizeHistoryForVertex(history)
          : [{ role: 'user', parts: [{ text: ' ' }] }];
      const config: CountTokensConfig = {};
      if (options.systemInstruction) {
        config.systemInstruction = options.systemInstruction;
      }
      if (options.enableTools) {
        config.tools = [{ functionDeclarations: GLITCH_TOOL_DECLARATIONS }];
      }
      const res = await this.ai.models.countTokens({
        model: options.model,
        contents: normalizedContents,
        config,
      });
      if (res && typeof res.totalTokens === 'number' && res.totalTokens > 0) {
        return res.totalTokens;
      }
    } catch {
      // Fallback silencioso si la API no está disponible
    }
    return null;
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
