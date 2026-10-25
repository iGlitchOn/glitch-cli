import { GoogleGenAI, type Content } from '@google/genai';
import type { VertexConfig } from '../config/settings.js';

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

export async function* streamVertexChat(
  ai: GoogleGenAI,
  model: string,
  contents: Content[],
  abortSignal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  const responseStream = await ai.models.generateContentStream({
    model,
    contents,
    config: abortSignal ? { abortSignal } : undefined,
  });

  for await (const chunk of responseStream) {
    if (chunk.text) {
      yield chunk.text;
    }
  }
}
