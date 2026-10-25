import {
  GoogleGenAI,
  type Content,
  type GenerateContentConfig,
  type Part,
} from '@google/genai';
import { buildVertexThinkingConfig } from '../config/models.js';
import type { EffortLevel, VertexConfig } from '../config/settings.js';

export function createVertexGenAI(config: VertexConfig): GoogleGenAI {
  if (!config.project?.trim()) {
    throw new Error('Falta GOOGLE_CLOUD_PROJECT para inicializar Vertex AI.');
  }
  if (!config.location?.trim()) {
    throw new Error('Falta GOOGLE_CLOUD_LOCATION para inicializar Vertex AI.');
  }

  process.env['GOOGLE_CLOUD_PROJECT'] = config.project.trim();
  process.env['GOOGLE_CLOUD_LOCATION'] = config.location.trim();

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
}

export async function* streamVertexChat(
  ai: GoogleGenAI,
  model: string,
  contents: Content[],
  options: VertexStreamOptions = {},
): AsyncGenerator<string, void, unknown> {
  const thinkingConfig = buildVertexThinkingConfig(
    model,
    options.effort ?? 'medium',
    options.includeThoughts ?? true,
  );

  const config: GenerateContentConfig = {};
  if (thinkingConfig) {
    config.thinkingConfig = thinkingConfig;
  }
  if (options.abortSignal) {
    config.abortSignal = options.abortSignal;
  }

  const responseStream = await ai.models.generateContentStream({
    model,
    contents,
    config,
  });

  for await (const chunk of responseStream) {
    const parts = chunk.candidates?.[0]?.content?.parts;
    if (parts && parts.length > 0 && options.onParts) {
      options.onParts(parts);
    }
    if (chunk.text) {
      yield chunk.text;
    }
  }
}
