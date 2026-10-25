import {
  ThinkingLevel,
  type GoogleGenAI,
  type ThinkingConfig,
} from '@google/genai';
import type { EffortLevel, ProviderType } from './settings.js';

export interface ModelDefinition {
  id: string;
  name: string;
  family: 'gemini' | 'gemma' | 'custom';
  supportedEfforts: EffortLevel[];
  defaultEffort?: EffortLevel;
  supportsThoughts: boolean;
  forbidThinkingBudget?: boolean;
}

/**
 * Registro local de modelos oficiales de Google en Vertex AI (Gemini y Gemma).
 * Excluye modelos de terceros (Claude, Llama, Mistral) que no entran en el Free Trial.
 */
export const LOCAL_GOOGLE_MODELS: readonly ModelDefinition[] = [
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    family: 'gemini',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    supportsThoughts: true,
    forbidThinkingBudget: true,
  },
  {
    id: 'gemini-4-argon-cyber-permissive',
    name: 'Gemini 4 Argon (Cyber Permissive)',
    family: 'gemini',
    supportedEfforts: ['high'],
    defaultEffort: 'high',
    supportsThoughts: true,
    forbidThinkingBudget: true,
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview',
    family: 'gemini',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    supportsThoughts: true,
    forbidThinkingBudget: true,
  },
  {
    id: 'gemini-3.1-flash-lite-preview',
    name: 'Gemini 3.1 Flash-Lite Preview',
    family: 'gemini',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    supportsThoughts: true,
    forbidThinkingBudget: true,
  },
  {
    id: 'gemini-3-pro-preview',
    name: 'Gemini 3 Pro Preview',
    family: 'gemini',
    supportedEfforts: ['low', 'high'],
    defaultEffort: 'high',
    supportsThoughts: true,
    forbidThinkingBudget: true,
  },
  {
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash Preview',
    family: 'gemini',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    supportsThoughts: true,
    forbidThinkingBudget: true,
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    family: 'gemini',
    supportedEfforts: [],
    supportsThoughts: true,
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    family: 'gemini',
    supportedEfforts: [],
    supportsThoughts: true,
  },
  {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash-Lite',
    family: 'gemini',
    supportedEfforts: [],
    supportsThoughts: true,
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    family: 'gemini',
    supportedEfforts: [],
    supportsThoughts: false,
  },
  {
    id: 'gemini-2.0-flash-lite',
    name: 'Gemini 2.0 Flash-Lite',
    family: 'gemini',
    supportedEfforts: [],
    supportsThoughts: false,
  },
  {
    id: 'gemma-3-27b-it',
    name: 'Gemma 3 27B IT',
    family: 'gemma',
    supportedEfforts: [],
    supportsThoughts: false,
  },
  {
    id: 'gemma-3-12b-it',
    name: 'Gemma 3 12B IT',
    family: 'gemma',
    supportedEfforts: [],
    supportsThoughts: false,
  },
  {
    id: 'gemma-3-4b-it',
    name: 'Gemma 3 4B IT',
    family: 'gemma',
    supportedEfforts: [],
    supportsThoughts: false,
  },
];

export function isGoogleFreeTrialModelId(rawId: string): boolean {
  const normalized = normalizeModelId(rawId).toLowerCase();
  if (
    normalized.includes('claude') ||
    normalized.includes('anthropic') ||
    normalized.includes('llama') ||
    normalized.includes('mistral') ||
    normalized.includes('jamba') ||
    normalized.includes('codestral')
  ) {
    return false;
  }
  return normalized.startsWith('gemini-') || normalized.startsWith('gemma-');
}

export function normalizeModelId(rawName: string): string {
  const trimmed = rawName.trim();
  const parts = trimmed.split('/');
  return parts[parts.length - 1] || trimmed;
}

export function getModelDefinition(
  modelId: string,
  provider: ProviderType = 'vertex',
): ModelDefinition {
  const cleanId = normalizeModelId(modelId);
  const found = LOCAL_GOOGLE_MODELS.find((m) => m.id === cleanId);
  if (found) {
    return found;
  }

  if (provider === 'custom') {
    return {
      id: cleanId,
      name: cleanId,
      family: 'custom',
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      supportsThoughts: true,
    };
  }

  if (cleanId.startsWith('gemini-4-argon-cyber-permissive')) {
    return {
      id: cleanId,
      name: cleanId,
      family: 'gemini',
      supportedEfforts: ['high'],
      defaultEffort: 'high',
      supportsThoughts: true,
      forbidThinkingBudget: true,
    };
  }

  if (cleanId.startsWith('gemini-4-argon') || cleanId.startsWith('gemini-3')) {
    return {
      id: cleanId,
      name: cleanId,
      family: 'gemini',
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      supportsThoughts: true,
      forbidThinkingBudget: true,
    };
  }

  if (cleanId.startsWith('gemma-')) {
    return {
      id: cleanId,
      name: cleanId,
      family: 'gemma',
      supportedEfforts: [],
      supportsThoughts: false,
    };
  }

  return {
    id: cleanId,
    name: cleanId,
    family: 'gemini',
    supportedEfforts: [],
    supportsThoughts: cleanId.startsWith('gemini-2.5'),
  };
}

export async function listVertexGoogleModels(
  ai?: GoogleGenAI,
): Promise<ModelDefinition[]> {
  if (!ai) {
    return [...LOCAL_GOOGLE_MODELS];
  }

  try {
    const pager = await ai.models.list();
    const discoveredIds = new Set<string>();

    for await (const item of pager) {
      const candidateName = item.name ?? '';
      if (candidateName && isGoogleFreeTrialModelId(candidateName)) {
        discoveredIds.add(normalizeModelId(candidateName));
      }
    }

    if (discoveredIds.size === 0) {
      return [...LOCAL_GOOGLE_MODELS];
    }

    const merged = new Map<string, ModelDefinition>();
    for (const preset of LOCAL_GOOGLE_MODELS) {
      merged.set(preset.id, preset);
    }
    for (const id of discoveredIds) {
      if (!merged.has(id)) {
        merged.set(id, getModelDefinition(id, 'vertex'));
      }
    }
    return Array.from(merged.values());
  } catch {
    return [...LOCAL_GOOGLE_MODELS];
  }
}

const EFFORT_TO_THINKING_LEVEL: Record<EffortLevel, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * Construye thinkingConfig para Vertex AI garantizando que:
 * - Nunca se envíe thinkingBudget ni MINIMAL a Argon (causan HTTP 400).
 * - Solo se envíe thinkingLevel si el modelo lo soporta y dentro de sus niveles permitidos.
 */
export function buildVertexThinkingConfig(
  modelId: string,
  effort: EffortLevel,
  includeThoughts: boolean,
): ThinkingConfig | undefined {
  const def = getModelDefinition(modelId, 'vertex');

  if (!def.supportsThoughts && def.supportedEfforts.length === 0) {
    return undefined;
  }

  const config: ThinkingConfig = {
    includeThoughts,
  };

  if (def.supportedEfforts.length > 0) {
    const effectiveEffort = def.supportedEfforts.includes(effort)
      ? effort
      : (def.defaultEffort ?? def.supportedEfforts[0]!);
    config.thinkingLevel = EFFORT_TO_THINKING_LEVEL[effectiveEffort];
  }

  // Guardia explícita anti-400 para Argon: jamás permitir thinkingBudget ni MINIMAL
  if (def.forbidThinkingBudget || def.id.includes('argon')) {
    delete (config as Record<string, unknown>)['thinkingBudget'];
    if (config.thinkingLevel === ThinkingLevel.MINIMAL) {
      config.thinkingLevel = ThinkingLevel.LOW;
    }
  }

  return config;
}
