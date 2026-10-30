import type { Content, Part } from '@google/genai';
import { recordApiRequestDebugLog } from '../config/models.js';
import {
  maskApiKey,
  type CustomApiConfig,
  type EffortLevel,
} from '../config/settings.js';
import { withRetry, type RetryOptions } from '../core/retry.js';
import { GLITCH_TOOL_DECLARATIONS } from '../core/tools.js';
import type {
  ApiTokenUsage,
  ProviderAdapter,
  ProviderRequestOptions,
  ProviderStreamChunk,
  RawApiUsageMetadata,
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

function normalizeSchemaToLowerType(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const copy: Record<string, unknown> = { ...schema };
  if (typeof copy['type'] === 'string') {
    copy['type'] = copy['type'].toLowerCase();
  }
  if (copy['properties'] && typeof copy['properties'] === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(
      copy['properties'] as Record<string, unknown>,
    )) {
      props[k] = normalizeSchemaToLowerType(
        v as Record<string, unknown> | undefined,
      );
    }
    copy['properties'] = props;
  }
  if (copy['items'] && typeof copy['items'] === 'object') {
    copy['items'] = normalizeSchemaToLowerType(
      copy['items'] as Record<string, unknown> | undefined,
    );
  }
  return copy;
}

export function buildOpenAiToolsFromDeclarations(
  format: CustomApiConfig['format'] = 'chat_completions',
): Array<Record<string, unknown>> {
  return GLITCH_TOOL_DECLARATIONS.map((decl) => {
    const parameters = normalizeSchemaToLowerType(
      decl.parameters as unknown as Record<string, unknown> | undefined,
    );
    if (format === 'responses') {
      return {
        type: 'function',
        name: decl.name ?? '',
        description: decl.description ?? '',
        parameters,
      };
    }
    return {
      type: 'function',
      function: {
        name: decl.name ?? '',
        description: decl.description ?? '',
        parameters,
      },
    };
  });
}

export function buildCustomRequestBody(
  config: CustomApiConfig,
  history: readonly Content[],
  options: ProviderRequestOptions,
  supportsReasoningEffort = true,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  if (options.systemInstruction) {
    messages.push({
      role: 'system',
      content: options.systemInstruction,
    });
  }

  let syntheticCallCounter = 0;
  for (const turn of history) {
    const parts = turn.parts ?? [];
    const fnResponses = parts.filter((p) => Boolean(p.functionResponse));
    if (fnResponses.length > 0) {
      for (const p of fnResponses) {
        const resp = p.functionResponse!;
        const callId = resp.id || `call_${resp.name ?? 'tool'}_${++syntheticCallCounter}`;
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          name: resp.name ?? 'tool',
          content: JSON.stringify(resp.response ?? {}),
        });
      }
      continue;
    }

    const fnCalls = parts.filter((p) => Boolean(p.functionCall));
    const textContent = parts
      .filter((p) => !(p as Record<string, unknown>)['thought'] && !p.functionCall)
      .map((p) => p.text ?? '')
      .join('');

    if (turn.role === 'model' && fnCalls.length > 0) {
      const toolCalls = fnCalls.map((p) => {
        const fc = p.functionCall!;
        const callId = fc.id || `call_${fc.name ?? 'tool'}_${++syntheticCallCounter}`;
        return {
          id: callId,
          type: 'function',
          function: {
            name: fc.name ?? '',
            arguments: JSON.stringify(fc.args ?? {}),
          },
        };
      });
      messages.push({
        role: 'assistant',
        content: textContent || null,
        tool_calls: toolCalls,
      });
      continue;
    }

    const role = turn.role === 'model' ? 'assistant' : 'user';
    messages.push({ role, content: textContent });
  }

  if (config.format === 'responses') {
    const payload: Record<string, unknown> = {
      model: options.model,
      input: messages,
      stream: false,
    };
    if (options.systemInstruction) {
      payload['instructions'] = options.systemInstruction;
    }
    if (options.enableTools) {
      payload['tools'] = buildOpenAiToolsFromDeclarations('responses');
    }
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
  if (options.enableTools) {
    payload['tools'] = buildOpenAiToolsFromDeclarations('chat_completions');
  }
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

function parseToolCallArguments(rawArgs: unknown): Record<string, unknown> {
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return rawArgs as Record<string, unknown>;
  }
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
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
    let lastSentIncludeThoughts = options.includeThoughts;

    const jsonData = await withRetry(
      async () => {
        const liveOpts = options.getLiveOptions
          ? options.getLiveOptions()
          : options;
        lastSentIncludeThoughts = liveOpts.includeThoughts;

        const body = buildCustomRequestBody(
          this.config,
          history,
          liveOpts,
          this.supportsReasoningEffort,
        );

        const paramLabel = this.supportsReasoningEffort
          ? this.config.format === 'responses'
            ? `reasoning.effort=${liveOpts.effort}`
            : `reasoning_effort=${liveOpts.effort}`
          : 'reasoning_effort=N/A';

        recordApiRequestDebugLog({
          provider: 'custom',
          model: liveOpts.model,
          effort: liveOpts.effort,
          thinkingParameter: paramLabel,
          subMode: liveOpts.subMode,
          includeThoughts: liveOpts.includeThoughts,
        });

        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: liveOpts.abortSignal ?? options.abortSignal,
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
      },
      {
        maxRetries: 9,
        baseDelayMs: 600,
        ...this.retryOptions,
      },
    );

    const apiUsage = extractCustomApiUsage(jsonData);

    if (this.config.format === 'responses') {
      const responseReasoning = extractResponsesReasoningText(jsonData);
      const outputText =
        typeof jsonData['output_text'] === 'string'
          ? jsonData['output_text']
          : extractResponsesOutputText(jsonData);
      const responseToolCalls = extractResponsesToolCalls(jsonData);
      if (responseReasoning && lastSentIncludeThoughts) {
        yield {
          thoughtText: responseReasoning,
          rawParts: [{ text: responseReasoning, thought: true }],
          usage: !outputText && responseToolCalls.length === 0 ? apiUsage : undefined,
        };
      }
      if (outputText) {
        yield {
          text: outputText,
          rawParts: [{ text: outputText }],
          usage: responseToolCalls.length === 0 ? apiUsage : undefined,
        };
      }
      if (responseToolCalls.length > 0) {
        yield {
          rawParts: responseToolCalls,
          usage: apiUsage,
        };
      }
      if (!responseReasoning && !outputText && responseToolCalls.length === 0 && apiUsage) {
        yield { usage: apiUsage };
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
        : typeof firstMessage?.['reasoning'] === 'string'
          ? firstMessage['reasoning']
          : typeof firstMessage?.['thinking'] === 'string'
            ? firstMessage['thinking']
            : undefined;

    const rawToolCalls = Array.isArray(firstMessage?.['tool_calls'])
      ? (firstMessage['tool_calls'] as Array<Record<string, unknown>>)
      : [];

    if (reasoning && lastSentIncludeThoughts) {
      yield {
        thoughtText: reasoning,
        rawParts: [{ text: reasoning, thought: true }],
        usage: !text && rawToolCalls.length === 0 ? apiUsage : undefined,
      };
    }

    if (text) {
      yield {
        text,
        rawParts: [{ text }],
        usage: rawToolCalls.length === 0 ? apiUsage : undefined,
      };
    }

    if (rawToolCalls.length > 0) {
      const fnParts: Part[] = [];
      for (const tc of rawToolCalls) {
        const fnObj = tc['function'] as Record<string, unknown> | undefined;
        const name =
          typeof fnObj?.['name'] === 'string'
            ? fnObj['name']
            : typeof tc['name'] === 'string'
              ? tc['name']
              : '';
        if (!name) continue;
        const id =
          typeof tc['id'] === 'string' && tc['id']
            ? tc['id']
            : `call_${name}_${Date.now()}`;
        const args = parseToolCallArguments(
          fnObj?.['arguments'] ?? tc['arguments'],
        );
        fnParts.push({
          functionCall: {
            id,
            name,
            args,
          },
        });
      }
      if (fnParts.length > 0) {
        yield {
          rawParts: fnParts,
          usage: apiUsage,
        };
      }
    }

    if (!reasoning && !text && rawToolCalls.length === 0 && apiUsage) {
      yield { usage: apiUsage };
    }
  }
}

function extractCustomApiUsage(
  data: Record<string, unknown>,
): ApiTokenUsage | undefined {
  const usage = data['usage'] as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const promptDetails = usage['prompt_tokens_details'] as
    | Record<string, unknown>
    | undefined;
  const inputDetails = usage['input_tokens_details'] as
    | Record<string, unknown>
    | undefined;
  const completionDetails = usage['completion_tokens_details'] as
    | Record<string, unknown>
    | undefined;
  const outputDetails = usage['output_tokens_details'] as
    | Record<string, unknown>
    | undefined;

  const rawInput =
    typeof usage['prompt_tokens'] === 'number'
      ? usage['prompt_tokens']
      : typeof usage['input_tokens'] === 'number'
        ? usage['input_tokens']
        : typeof usage['inputTokens'] === 'number'
          ? usage['inputTokens']
          : null;

  const rawCached =
    typeof usage['cached_tokens'] === 'number'
      ? usage['cached_tokens']
      : typeof usage['cachedTokens'] === 'number'
        ? usage['cachedTokens']
        : typeof promptDetails?.['cached_tokens'] === 'number'
          ? promptDetails['cached_tokens']
          : typeof inputDetails?.['cached_tokens'] === 'number'
            ? inputDetails['cached_tokens']
            : null;

  const rawOutput =
    typeof usage['completion_tokens'] === 'number'
      ? usage['completion_tokens']
      : typeof usage['output_tokens'] === 'number'
        ? usage['output_tokens']
        : typeof usage['outputTokens'] === 'number'
          ? usage['outputTokens']
          : null;

  const rawReasoning =
    typeof usage['reasoning_tokens'] === 'number'
      ? usage['reasoning_tokens']
      : typeof usage['reasoningTokens'] === 'number'
        ? usage['reasoningTokens']
        : typeof completionDetails?.['reasoning_tokens'] === 'number'
          ? completionDetails['reasoning_tokens']
          : typeof outputDetails?.['reasoning_tokens'] === 'number'
            ? outputDetails['reasoning_tokens']
            : null;

  const rawTotal =
    typeof usage['total_tokens'] === 'number'
      ? usage['total_tokens']
      : typeof usage['totalTokens'] === 'number'
        ? usage['totalTokens']
        : null;

  const rawMetadata: RawApiUsageMetadata = {
    promptTokenCount: rawInput,
    candidatesTokenCount: rawOutput,
    cachedContentTokenCount: rawCached,
    thoughtsTokenCount: rawReasoning,
    toolUsePromptTokenCount: null,
    totalTokenCount: rawTotal,
  };

  const totalPrompt = Math.max(0, rawInput ?? 0);
  const cached = Math.max(0, rawCached ?? 0);

  return {
    inputTokens: Math.max(0, totalPrompt - cached),
    outputTokens: Math.max(0, rawOutput ?? 0),
    cachedTokens: cached,
    reasoningTokens: Math.max(0, rawReasoning ?? 0),
    toolUsePromptTokens: 0,
    totalPromptTokens: totalPrompt,
    rawMetadata,
  };
}

function extractResponsesReasoningText(data: Record<string, unknown>): string {
  const output = Array.isArray(data['output'])
    ? (data['output'] as Array<Record<string, unknown>>)
    : [];
  const thoughts: string[] = [];
  for (const item of output) {
    const itemType =
      typeof item['type'] === 'string' ? item['type'].toLowerCase() : '';
    if (itemType === 'reasoning' || itemType === 'thinking') {
      if (typeof item['text'] === 'string') {
        thoughts.push(item['text']);
      }
      const summary = Array.isArray(item['summary'])
        ? (item['summary'] as Array<Record<string, unknown>>)
        : [];
      for (const s of summary) {
        if (typeof s['text'] === 'string') {
          thoughts.push(s['text']);
        }
      }
    }
    const content = Array.isArray(item['content'])
      ? (item['content'] as Array<Record<string, unknown>>)
      : [];
    for (const part of content) {
      const pType =
        typeof part['type'] === 'string' ? part['type'].toLowerCase() : '';
      if (
        (pType === 'reasoning' ||
          pType === 'thinking' ||
          pType === 'reasoning_text') &&
        typeof part['text'] === 'string'
      ) {
        thoughts.push(part['text']);
      }
    }
  }
  return thoughts.join('');
}

function extractResponsesOutputText(data: Record<string, unknown>): string {
  const output = Array.isArray(data['output'])
    ? (data['output'] as Array<Record<string, unknown>>)
    : [];
  const texts: string[] = [];
  for (const item of output) {
    const itemType =
      typeof item['type'] === 'string' ? item['type'].toLowerCase() : '';
    if (itemType === 'reasoning' || itemType === 'thinking') {
      continue;
    }
    const content = Array.isArray(item['content'])
      ? (item['content'] as Array<Record<string, unknown>>)
      : [];
    for (const part of content) {
      const pType =
        typeof part['type'] === 'string' ? part['type'].toLowerCase() : '';
      if (
        pType === 'reasoning' ||
        pType === 'thinking' ||
        pType === 'reasoning_text'
      ) {
        continue;
      }
      if (typeof part['text'] === 'string') {
        texts.push(part['text']);
      }
    }
  }
  return texts.join('');
}

function extractResponsesToolCalls(data: Record<string, unknown>): Part[] {
  const output = Array.isArray(data['output'])
    ? (data['output'] as Array<Record<string, unknown>>)
    : [];
  const parts: Part[] = [];
  for (const item of output) {
    if (item['type'] === 'function_call' && typeof item['name'] === 'string') {
      const id =
        typeof item['call_id'] === 'string'
          ? item['call_id']
          : typeof item['id'] === 'string'
            ? item['id']
            : `call_${item['name']}`;
      parts.push({
        functionCall: {
          id,
          name: item['name'],
          args: parseToolCallArguments(item['arguments']),
        },
      });
    }
  }
  return parts;
}
