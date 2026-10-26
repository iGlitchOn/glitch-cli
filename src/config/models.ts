import {
  ThinkingLevel,
  type GoogleGenAI,
  type ThinkingConfig,
} from '@google/genai';
import type { EffortLevel, ProviderType } from './settings.js';

export type ModelFamily =
  | 'gemini'
  | 'gemma'
  | 'nano-banana'
  | 'embeddings'
  | 'media-live'
  | 'custom';

export interface ModelFamilyPage {
  family: ModelFamily;
  title: string;
  models: ModelDefinition[];
}

export interface ModelDefinition {
  id: string;
  name: string;
  family: ModelFamily;
  releaseDate: string; // YYYY-MM-DD para ordenar más reciente arriba
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
    .join(' - ');
}

/**
 * Registro local de modelos oficiales de Google en Vertex AI,
 * separados estrictamente por categoría y con fecha de lanzamiento (YYYY-MM-DD).
 */
export const LOCAL_GOOGLE_MODELS: readonly ModelDefinition[] = [
  // Página 1: Gemini (Chat, Código y Razonamiento)
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    family: 'gemini',
    releaseDate: '2026-04-15',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    supportsThoughts: true,
    forbidThinkingBudget: true,
  },
  {
    id: 'gemini-4-argon-cyber-permissive',
    name: 'Gemini 4 Argon Cyber Permissive',
    family: 'gemini',
    releaseDate: '2026-04-15',
    supportedEfforts: ['high'],
    defaultEffort: 'high',
    supportsThoughts: true,
    forbidThinkingBudget: true,
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview',
    family: 'gemini',
    releaseDate: '2026-03-10',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    supportsThoughts: true,
    forbidThinkingBudget: true,
  },
  {
    id: 'gemini-3.1-flash-lite-preview',
    name: 'Gemini 3.1 Flash-Lite Preview',
    family: 'gemini',
    releaseDate: '2026-03-01',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    supportsThoughts: true,
    forbidThinkingBudget: true,
  },
  {
    id: 'gemini-3-pro-preview',
    name: 'Gemini 3 Pro Preview',
    family: 'gemini',
    releaseDate: '2026-01-20',
    supportedEfforts: ['low', 'high'],
    defaultEffort: 'high',
    supportsThoughts: true,
    forbidThinkingBudget: true,
  },
  {
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash Preview',
    family: 'gemini',
    releaseDate: '2026-01-15',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    supportsThoughts: true,
    forbidThinkingBudget: true,
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    family: 'gemini',
    releaseDate: '2025-06-17',
    supportedEfforts: [],
    supportsThoughts: true,
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    family: 'gemini',
    releaseDate: '2025-06-17',
    supportedEfforts: [],
    supportsThoughts: true,
  },
  {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash-Lite',
    family: 'gemini',
    releaseDate: '2025-06-17',
    supportedEfforts: [],
    supportsThoughts: true,
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    family: 'gemini',
    releaseDate: '2025-02-05',
    supportedEfforts: [],
    supportsThoughts: false,
  },
  {
    id: 'gemini-2.0-flash-lite',
    name: 'Gemini 2.0 Flash-Lite',
    family: 'gemini',
    releaseDate: '2025-02-05',
    supportedEfforts: [],
    supportsThoughts: false,
  },

  // Página 2: Gemma
  {
    id: 'gemma-3-27b-it',
    name: 'Gemma 3 27B IT',
    family: 'gemma',
    releaseDate: '2025-03-12',
    supportedEfforts: [],
    supportsThoughts: false,
  },
  {
    id: 'gemma-3-12b-it',
    name: 'Gemma 3 12B IT',
    family: 'gemma',
    releaseDate: '2025-03-12',
    supportedEfforts: [],
    supportsThoughts: false,
  },
  {
    id: 'gemma-3-4b-it',
    name: 'Gemma 3 4B IT',
    family: 'gemma',
    releaseDate: '2025-03-12',
    supportedEfforts: [],
    supportsThoughts: false,
  },

  // Página 3: Nano Banana & Imagen
  {
    id: 'gemini-3-pro-image-preview',
    name: 'Nano Banana Pro (Gemini 3 Pro Image)',
    family: 'nano-banana',
    releaseDate: '2026-02-01',
    supportedEfforts: ['low', 'high'],
    defaultEffort: 'high',
    supportsThoughts: true,
    forbidThinkingBudget: true,
  },
  {
    id: 'gemini-2.5-flash-image',
    name: 'Nano Banana (Gemini 2.5 Flash Image)',
    family: 'nano-banana',
    releaseDate: '2025-08-26',
    supportedEfforts: [],
    supportsThoughts: false,
  },
  {
    id: 'imagen-3.0-generate-002',
    name: 'Imagen 3 Generate',
    family: 'nano-banana',
    releaseDate: '2025-02-01',
    supportedEfforts: [],
    supportsThoughts: false,
  },
  {
    id: 'imagen-3.0-fast-generate-001',
    name: 'Imagen 3 Fast',
    family: 'nano-banana',
    releaseDate: '2025-02-01',
    supportedEfforts: [],
    supportsThoughts: false,
  },

  // Página 4: Embeddings
  {
    id: 'gemini-embedding-2-preview',
    name: 'Gemini Embedding 2 Preview',
    family: 'embeddings',
    releaseDate: '2026-02-10',
    supportedEfforts: [],
    supportsThoughts: false,
  },
  {
    id: 'gemini-embedding-001',
    name: 'Gemini Embedding 001',
    family: 'embeddings',
    releaseDate: '2025-05-20',
    supportedEfforts: [],
    supportsThoughts: false,
  },
];

export function sortModelsByDateDesc(
  models: readonly ModelDefinition[],
): ModelDefinition[] {
  return [...models].sort((a, b) => {
    const cmp = b.releaseDate.localeCompare(a.releaseDate);
    if (cmp !== 0) return cmp;
    return a.name.localeCompare(b.name);
  });
}

export function groupModelsByFamilyPages(
  models: readonly ModelDefinition[],
): ModelFamilyPage[] {
  const familyMeta: Array<{ family: ModelFamily; title: string }> = [
    { family: 'gemini', title: 'Gemini (Chat & Argon)' },
    { family: 'gemma', title: 'Gemma' },
    { family: 'nano-banana', title: 'Nano Banana & Imagen' },
    { family: 'embeddings', title: 'Embeddings' },
    { family: 'media-live', title: 'Audio, Live & Video' },
    { family: 'custom', title: 'Custom' },
  ];

  const pages: ModelFamilyPage[] = [];
  for (const meta of familyMeta) {
    const familyModels = sortModelsByDateDesc(
      models.filter((m) => m.family === meta.family),
    );
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
  nameColWidth = 36,
  idColWidth = 32,
  dateColWidth = 10,
): {
  nameCol: string;
  idCol: string;
  dateCol: string;
  effortsCol: string;
  formatted: string;
} {
  const activeSuffix = isActive ? ' (active)' : '';
  const rawName = `${model.name}${activeSuffix}`;
  const nameCol = rawName.padEnd(nameColWidth, ' ');
  const idCol = model.id.padEnd(idColWidth, ' ');
  const dateCol = model.releaseDate.padEnd(dateColWidth, ' ');
  const effortsCol = formatOrderedEfforts(model.supportedEfforts);
  return {
    nameCol,
    idCol,
    dateCol,
    effortsCol,
    formatted: `${nameCol} | ${idCol} | ${dateCol} | ${effortsCol}`,
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

function inferModelFamily(cleanId: string): ModelFamily {
  const lower = cleanId.toLowerCase();
  if (lower.includes('embedding')) {
    return 'embeddings';
  }
  if (
    lower.includes('image') ||
    lower.startsWith('imagen-') ||
    lower.includes('nano-banana')
  ) {
    return 'nano-banana';
  }
  if (
    lower.includes('-live') ||
    lower.includes('-tts') ||
    lower.includes('-audio') ||
    lower.startsWith('veo-')
  ) {
    return 'media-live';
  }
  if (lower.startsWith('gemma-')) {
    return 'gemma';
  }
  return 'gemini';
}

function inferReleaseDate(cleanId: string): string {
  const lower = cleanId.toLowerCase();
  // Si trae fecha mm-dd o yyyy en el ID, o por generación de modelo
  if (lower.includes('gemini-4')) return '2026-04-15';
  if (lower.includes('gemini-3.1')) return '2026-03-01';
  if (lower.includes('gemini-3') || lower.includes('embedding-2')) {
    return '2026-01-15';
  }
  if (lower.includes('gemini-2.5')) return '2025-06-17';
  if (lower.includes('gemma-3')) return '2025-03-12';
  if (lower.includes('gemini-2.0') || lower.includes('imagen-3')) {
    return '2025-02-05';
  }
  return '2024-12-01';
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
      releaseDate: '2026-01-01',
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      supportsThoughts: true,
    };
  }

  const family = inferModelFamily(cleanId);
  const releaseDate = inferReleaseDate(cleanId);

  if (family !== 'gemini') {
    return {
      id: cleanId,
      name: cleanId,
      family,
      releaseDate,
      supportedEfforts: [],
      supportsThoughts: false,
    };
  }

  if (cleanId.startsWith('gemini-4-argon-cyber-permissive')) {
    return {
      id: cleanId,
      name: cleanId,
      family: 'gemini',
      releaseDate,
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
      releaseDate,
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      supportsThoughts: true,
      forbidThinkingBudget: true,
    };
  }

  return {
    id: cleanId,
    name: cleanId,
    family: 'gemini',
    releaseDate,
    supportedEfforts: [],
    supportsThoughts: cleanId.startsWith('gemini-2.5'),
  };
}

export async function listVertexGoogleModels(
  ai?: GoogleGenAI,
): Promise<ModelDefinition[]> {
  if (!ai) {
    return sortModelsByDateDesc(LOCAL_GOOGLE_MODELS);
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
      return sortModelsByDateDesc(LOCAL_GOOGLE_MODELS);
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
    return sortModelsByDateDesc(Array.from(merged.values()));
  } catch {
    return sortModelsByDateDesc(LOCAL_GOOGLE_MODELS);
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
