import type { Content, Part } from '@google/genai';
import type {
  EffortLevel,
  PermissionMode,
  SubMode,
} from '../config/settings.js';

export interface RawApiUsageMetadata {
  promptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  cachedContentTokenCount?: number | null;
  thoughtsTokenCount?: number | null;
  toolUsePromptTokenCount?: number | null;
  totalTokenCount?: number | null;
}

export interface ApiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  toolUsePromptTokens?: number;
  totalPromptTokens?: number;
  rawMetadata?: RawApiUsageMetadata;
}

export interface ProviderStreamChunk {
  text?: string;
  thoughtText?: string;
  rawParts?: Part[];
  usage?: ApiTokenUsage;
}

export interface ProviderRequestOptions {
  model: string;
  effort: EffortLevel;
  includeThoughts: boolean;
  subMode: SubMode;
  permissionMode?: PermissionMode;
  abortSignal?: AbortSignal;
  systemInstruction?: string;
  enableTools?: boolean;
  getLiveOptions?: () => ProviderRequestOptions;
}

export interface ProviderAdapter {
  readonly id: string;
  streamTurn(
    history: readonly Content[],
    options: ProviderRequestOptions,
  ): AsyncGenerator<ProviderStreamChunk, void, unknown>;
  countTokens?(
    history: readonly Content[],
    options: ProviderRequestOptions,
  ): Promise<number | null>;
}
