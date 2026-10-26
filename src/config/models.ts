import {
  ThinkingLevel,
  type GoogleGenAI,
  type ThinkingConfig,
} from '@google/genai';
import type { EffortLevel, ProviderType } from './settings.js';

export type ModelFamily = 'gemini' | 'gemma' | 'nano-banana' | 'custom';

export interface ModelFamilyPage {
  family: ModelFamily;
  title: string;
  models: ModelDefinition[];
}

export interface ModelDefinition {
  id: string;
  name: string;
  family: ModelFamily;
  supportedEfforts: EffortLevel[];
  defaultEffort?: EffortLevel;
  supportsThoughts: boolean;
  forbidThinkingBudget?: boolean;
}

const EFFORT_SORT_ORDER: Record<EffortLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export function formatOrderedEfforts(efforts: readonly EffortLevel[]): string {
  if (efforts.length === 0) {
    return 'N/A';
  }
  return [...efforts]
    .sort((a, b) => EFFORT_SORT_ORDER[a] - EFFORT_SORT_ORDER[b])
    .map((e) => e.toUpperCase())
    .join(', ');
}

/**
 * Registro local de modelos oficiales de Google en Vertex AI:
 * - Familia 1 (gemini): Gemini 4 Argon, Gemini 3.1, Gemini 3, Gemini 2.5, Gemini 2.0
 * - Familia 2 (gemma): Gemma 3 (27B, 12B, 4B)
 * - Familia 3 (nano-banana): Nano Banana / Gemini Flash Image & Imagen 3
 */
export const LOCAL_GOOGLE_MODELS: readonly ModelDefinition[] = [
  // Página 1: Familia Gemini
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
    name: 'Gemini 4 Argon Cyber Permissive',
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

  // Página 2: Familia Gemma
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

  // Página 3: Familia Nano Banana & Imagen
  {
    id: 'gemini-2.5-flash-image',
    name: 'Nano Banana (Gemini 2.5 Flash Image)',
    family: 'nano-banana',
    supportedEfforts: [],
    supportsThoughts: false,
  },
  {
    id: 'gemini-3-pro-image-preview',
    name: 'Nano Banana Pro (Gemini 3 Pro Image)',
    family: 'nano-banana',
    supportedEfforts: ['low', 'high'],
    defaultEffort: 'high',
    supportsThoughts: true,
    forbidThinkingBudget: true,
  },
  {
    id: 'imagen-3.0-generate-002',
    name: 'Imagen 3 Generate',
    family: 'nano-banana',
    supportedEfforts: [],
    supportsThoughts: false,
  },
  {
    id: 'imagen-3.0-fast-generate-001',
    name: 'Imagen 3 Fast',
    family: 'nano-banana',
    supportedEfforts: [],
    supportsThoughts: false,
  },
];

export function groupModelsByFamilyPages(
  models: readonly ModelDefinition[],
): ModelFamilyPage[] {
  const familyMeta: Array<{ family: ModelFamily; title: string }> = [
    { family: 'gemini', title: 'Gemini' },
    { family: 'gemma', title: 'Gemma' },
    { family: 'nano-banana', title: 'Nano Banana & Imagen' },
    { family: 'custom', title: 'Custom' },
  ];

  const pages: ModelFamilyPage[] = [];
  for (const meta of familyMeta) {
    const familyModels = models.filter((m) => m.family === meta.family);
    if (familyModels.length > 0) {
      pages.push({
        family: meta.family,
        title: meta.title,
        models: familyModels,
      });
    }
  }
  return pages;
}

export function formatModelRowColumns(
  model: ModelDefinition,
  isActive: boolean,
  nameColWidth = 38,
  idColWidth = 34,
): { nameCol: string; idCol: string; effortsCol: string; formatted: string } {
  const activeSuffix = isActive ? ' (active)' : '';
  const rawName = `${model.name}${activeSuffix}`;
  const nameCol = rawName.padEnd(nameColWidth, ' ');
  const idCol = model.id.padEnd(idColWidth, ' ');
  const effortsCol = formatOrderedEfforts(model.supportedEfforts);
  return {
    nameCol,
    idCol,
    effortsCol,
    formatted: `${nameCol} | ${idCol} | ${effortsCol}`,
  };
}

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
  return (
    normalized.startsWith('gemini-') ||
    normalized.startsWith('gemma-') ||
    normalized.startsWith('imagen-')
  );
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

  if (cleanId.includes('image') || cleanId.startsWith('imagen-')) {
    return {
      id: cleanId,
      name: cleanId,
      family: 'nano-banana',
      supportedEfforts: [],
      supportsThoughts: false,
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

  if (def.forbidThinkingBudget || def.id.includes('argon')) {
    delete (config as Record<string, unknown>)['thinkingBudget'];
    if (config.thinkingLevel === ThinkingLevel.MINIMAL) {
      config.thinkingLevel = ThinkingLevel.LOW;
    }
  }

  return config;
}
