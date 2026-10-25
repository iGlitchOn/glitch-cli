import type { Content, Part } from '@google/genai';
import type { EffortLevel, SubMode } from '../config/settings.js';

export interface ProviderStreamChunk {
  text?: string;
  thoughtText?: string;
  rawParts?: Part[];
}

export interface ProviderRequestOptions {
  model: string;
  effort: EffortLevel;
  includeThoughts: boolean;
  subMode: SubMode;
  abortSignal?: AbortSignal;
}

export interface ProviderAdapter {
  readonly id: string;
  streamTurn(
    history: readonly Content[],
    options: ProviderRequestOptions,
  ): AsyncGenerator<ProviderStreamChunk, void, unknown>;
}
