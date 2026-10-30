import {
  ThinkingLevel,
  type GoogleGenAI,
  type ThinkingConfig,
} from '@google/genai';
import type { CustomApiConfig, EffortLevel, ProviderType } from './settings.js';

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

export type ContextWindowVerificationStatus =
  | 'verificado'
  | 'sin verificar'
  | 'no aplica';

export interface ModelDefinition {
  id: string;
  name: string;
  family: ModelFamily;
  releaseDate: string;
  supportedEfforts: EffortLevel[];
  defaultEffort?: EffortLevel;
  supportsThoughts: boolean;
  forbidThinkingBudget?: boolean;
  contextWindow: number | null;
  contextWindowStatus?: ContextWindowVerificationStatus;
}

export const DEFAULT_GEMINI_CONTEXT_WINDOW = 1_048_576;
export const GEMMA_3_CONTEXT_WINDOW = 131_072;

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

const UPPERCASE_TOKENS = new Set(['it', 'pt', 'tts', 'stt', 'hq', 'ai']);

export function formatHumanModelName(
  rawId: string,
  apiDisplayName?: string,
): string {
  const cleanId = normalizeModelId(rawId);

  if (
    apiDisplayName &&
    apiDisplayName.trim().length > 0 &&
    apiDisplayName.trim().toLowerCase() !== cleanId.toLowerCase() &&
    !apiDisplayName.includes('/')
  ) {
    return apiDisplayName.trim();
  }

  const lower = cleanId.toLowerCase();
  if (lower === 'gemini-2.5-flash-image') {
    return 'Nano Banana (Gemini 2.5 Flash Image)';
  }
  if (lower === 'gemini-3-pro-image-preview') {
    return 'Nano Banana Pro (Gemini 3 Pro Image)';
  }

  const normalized = cleanId.replace(/flash-lite/gi, 'FlashLiteToken');
  const tokens = normalized.split('-').filter(Boolean);

  const formattedTokens: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const tokLower = tok.toLowerCase();

    if (tok === 'FlashLiteToken') {
      formattedTokens.push('Flash-Lite');
      continue;
    }

    if (
      i === tokens.length - 2 &&
      /^\d{2}$/.test(tok) &&
      /^\d{2}$/.test(tokens[i + 1] ?? '')
    ) {
      formattedTokens.push(`(${tok}-${tokens[i + 1]})`);
      break;
    }

    if (i === tokens.length - 1 && /^\d{3}$/.test(tok)) {
      formattedTokens.push(tok);
      continue;
    }

    if (/^\d+b$/i.test(tok)) {
      formattedTokens.push(tok.toUpperCase());
      continue;
    }

    if (UPPERCASE_TOKENS.has(tokLower)) {
      formattedTokens.push(tok.toUpperCase());
      continue;
    }

    if (/^\d+(\.\d+)?$/.test(tok)) {
      formattedTokens.push(tok);
      continue;
    }

    formattedTokens.push(
      tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase(),
    );
  }

  return formattedTokens.join(' ');
}

export const LOCAL_GOOGLE_MODELS: readonly ModelDefinition[] = [
  // Página 1: Gemini (1.048.576 tokens)
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    family: 'gemini',
    releaseDate: '2026-04-15',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    supportsThoughts: true,
    forbidThinkingBudget: true,
    contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
    contextWindowStatus: 'verificado',
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
    contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
    contextWindowStatus: 'verificado',
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
    contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
    contextWindowStatus: 'verificado',
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
    contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
    contextWindowStatus: 'verificado',
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
    contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
    contextWindowStatus: 'verificado',
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
    contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
    contextWindowStatus: 'verificado',
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    family: 'gemini',
    releaseDate: '2025-06-17',
    supportedEfforts: [],
    supportsThoughts: true,
    contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
    contextWindowStatus: 'verificado',
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    family: 'gemini',
    releaseDate: '2025-06-17',
    supportedEfforts: [],
    supportsThoughts: true,
    contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
    contextWindowStatus: 'verificado',
  },
  {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash-Lite',
    family: 'gemini',
    releaseDate: '2025-06-17',
    supportedEfforts: [],
    supportsThoughts: true,
    contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
    contextWindowStatus: 'verificado',
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    family: 'gemini',
    releaseDate: '2025-02-05',
    supportedEfforts: [],
    supportsThoughts: false,
    contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
    contextWindowStatus: 'verificado',
  },
  {
    id: 'gemini-2.0-flash-lite',
    name: 'Gemini 2.0 Flash-Lite',
    family: 'gemini',
    releaseDate: '2025-02-05',
    supportedEfforts: [],
    supportsThoughts: false,
    contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
    contextWindowStatus: 'verificado',
  },

  // Página 2: Gemma (131.072 tokens, marcado "sin verificar")
  {
    id: 'gemma-3-27b-it',
    name: 'Gemma 3 27B IT',
    family: 'gemma',
    releaseDate: '2025-03-12',
    supportedEfforts: [],
    supportsThoughts: false,
    contextWindow: GEMMA_3_CONTEXT_WINDOW,
    contextWindowStatus: 'sin verificar',
  },
  {
    id: 'gemma-3-12b-it',
    name: 'Gemma 3 12B IT',
    family: 'gemma',
    releaseDate: '2025-03-12',
    supportedEfforts: [],
    supportsThoughts: false,
    contextWindow: GEMMA_3_CONTEXT_WINDOW,
    contextWindowStatus: 'sin verificar',
  },
  {
    id: 'gemma-3-4b-it',
    name: 'Gemma 3 4B IT',
    family: 'gemma',
    releaseDate: '2025-03-12',
    supportedEfforts: [],
    supportsThoughts: false,
    contextWindow: GEMMA_3_CONTEXT_WINDOW,
    contextWindowStatus: 'sin verificar',
  },

  // Página 3: Nano Banana & Imagen (no aplica)
  {
    id: 'gemini-3-pro-image-preview',
    name: 'Nano Banana Pro (Gemini 3 Pro Image)',
    family: 'nano-banana',
    releaseDate: '2026-02-01',
    supportedEfforts: ['low', 'high'],
    defaultEffort: 'high',
    supportsThoughts: true,
    forbidThinkingBudget: true,
    contextWindow: null,
    contextWindowStatus: 'no aplica',
  },
  {
    id: 'gemini-2.5-flash-image',
    name: 'Nano Banana (Gemini 2.5 Flash Image)',
    family: 'nano-banana',
    releaseDate: '2025-08-26',
    supportedEfforts: [],
    supportsThoughts: false,
    contextWindow: null,
    contextWindowStatus: 'no aplica',
  },
  {
    id: 'imagen-3.0-generate-002',
    name: 'Imagen 3 Generate',
    family: 'nano-banana',
    releaseDate: '2025-02-01',
    supportedEfforts: [],
    supportsThoughts: false,
    contextWindow: null,
    contextWindowStatus: 'no aplica',
  },
  {
    id: 'imagen-3.0-fast-generate-001',
    name: 'Imagen 3 Fast',
    family: 'nano-banana',
    releaseDate: '2025-02-01',
    supportedEfforts: [],
    supportsThoughts: false,
    contextWindow: null,
    contextWindowStatus: 'no aplica',
  },

  // Página 4: Embeddings (no aplica)
  {
    id: 'gemini-embedding-2-preview',
    name: 'Gemini Embedding 2 Preview',
    family: 'embeddings',
    releaseDate: '2026-02-10',
    supportedEfforts: [],
    supportsThoughts: false,
    contextWindow: null,
    contextWindowStatus: 'no aplica',
  },
  {
    id: 'gemini-embedding-001',
    name: 'Gemini Embedding 001',
    family: 'embeddings',
    releaseDate: '2025-05-20',
    supportedEfforts: [],
    supportsThoughts: false,
    contextWindow: null,
    contextWindowStatus: 'no aplica',
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
    { family: 'gemini', title: 'Gemini' },
    { family: 'gemma', title: 'Gemma' },
    { family: 'nano-banana', title: 'Nano Banana & Imagen' },
    { family: 'embeddings', title: 'Embeddings' },
    { family: 'media-live', title: 'Audio, Transcribe & Live' },
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
  const humanName =
    model.name === model.id ? formatHumanModelName(model.id) : model.name;
  const rawName = `${humanName}${activeSuffix}`;
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
    lower.includes('transcribe') ||
    lower.includes('-live') ||
    lower.includes('-tts') ||
    lower.includes('-stt') ||
    lower.includes('-audio') ||
    lower.includes('speech') ||
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
  if (lower.includes('gemini-4')) return '2026-04-15';
  if (lower.includes('gemini-3.8')) return '2026-04-05';
  if (lower.includes('gemini-3.7')) return '2026-03-28';
  if (lower.includes('gemini-3.6')) return '2026-03-20';
  if (lower.includes('gemini-3.5')) return '2026-03-15';
  if (lower.includes('gemini-3.1')) return '2026-03-01';
  if (lower.includes('gemini-3') || lower.includes('embedding-2')) {
    return '2026-01-15';
  }
  if (lower.includes('gemini-2.5-flash-preview-04-17')) return '2025-04-17';
  if (lower.includes('gemini-2.5-pro-exp-03-25')) return '2025-03-25';
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
  apiDisplayName?: string,
  customConfig?: CustomApiConfig,
): ModelDefinition {
  const cleanId = normalizeModelId(modelId);

  if (provider === 'custom') {
    const customWindow =
      customConfig?.contextWindow && customConfig.contextWindow > 0
        ? customConfig.contextWindow
        : DEFAULT_GEMINI_CONTEXT_WINDOW;
    return {
      id: cleanId,
      name: formatHumanModelName(cleanId, apiDisplayName),
      family: 'custom',
      releaseDate: '2026-01-01',
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      supportsThoughts: true,
      contextWindow: customWindow,
      contextWindowStatus: 'sin verificar',
    };
  }

  const found = LOCAL_GOOGLE_MODELS.find((m) => m.id === cleanId);
  if (found) {
    return found;
  }

  const humanName = formatHumanModelName(cleanId, apiDisplayName);
  const family = inferModelFamily(cleanId);
  const releaseDate = inferReleaseDate(cleanId);

  if (family === 'gemma') {
    return {
      id: cleanId,
      name: humanName,
      family,
      releaseDate,
      supportedEfforts: [],
      supportsThoughts: false,
      contextWindow: GEMMA_3_CONTEXT_WINDOW,
      contextWindowStatus: 'sin verificar',
    };
  }

  if (family === 'nano-banana' || family === 'embeddings') {
    return {
      id: cleanId,
      name: humanName,
      family,
      releaseDate,
      supportedEfforts: [],
      supportsThoughts: false,
      contextWindow: null,
      contextWindowStatus: 'no aplica',
    };
  }

  if (family !== 'gemini') {
    return {
      id: cleanId,
      name: humanName,
      family,
      releaseDate,
      supportedEfforts: [],
      supportsThoughts: false,
      contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
      contextWindowStatus: 'sin verificar',
    };
  }

  if (cleanId.startsWith('gemini-4-argon-cyber-permissive')) {
    return {
      id: cleanId,
      name: humanName,
      family: 'gemini',
      releaseDate,
      supportedEfforts: ['high'],
      defaultEffort: 'high',
      supportsThoughts: true,
      forbidThinkingBudget: true,
      contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
      contextWindowStatus: 'verificado',
    };
  }

  if (cleanId.startsWith('gemini-4-argon') || cleanId.startsWith('gemini-3')) {
    return {
      id: cleanId,
      name: humanName,
      family: 'gemini',
      releaseDate,
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      supportsThoughts: true,
      forbidThinkingBudget: true,
      contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
      contextWindowStatus: 'verificado',
    };
  }

  return {
    id: cleanId,
    name: humanName,
    family: 'gemini',
    releaseDate,
    supportedEfforts: [],
    supportsThoughts: cleanId.startsWith('gemini-2.5'),
    contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
    contextWindowStatus: 'verificado',
  };
}

export function getModelContextWindow(
  modelId: string,
  provider: ProviderType = 'vertex',
  customConfig?: CustomApiConfig,
): number {
  const def = getModelDefinition(modelId, provider, undefined, customConfig);
  return def.contextWindow ?? DEFAULT_GEMINI_CONTEXT_WINDOW;
}

export async function listVertexGoogleModels(
  ai?: GoogleGenAI,
): Promise<ModelDefinition[]> {
  if (!ai) {
    return sortModelsByDateDesc(LOCAL_GOOGLE_MODELS);
  }

  try {
    const pager = await ai.models.list();
    const discovered = new Map<string, string | undefined>();

    for await (const item of pager) {
      const candidateName = item.name ?? '';
      if (candidateName && isGoogleFreeTrialModelId(candidateName)) {
        const cleanId = normalizeModelId(candidateName);
        const displayName =
          typeof (item as Record<string, unknown>)['displayName'] === 'string'
            ? ((item as Record<string, unknown>)['displayName'] as string)
            : undefined;
        discovered.set(cleanId, displayName);
      }
    }

    if (discovered.size === 0) {
      return sortModelsByDateDesc(LOCAL_GOOGLE_MODELS);
    }

    const merged = new Map<string, ModelDefinition>();
    for (const preset of LOCAL_GOOGLE_MODELS) {
      merged.set(preset.id, preset);
    }
    for (const [id, displayName] of discovered.entries()) {
      if (!merged.has(id)) {
        merged.set(id, getModelDefinition(id, 'vertex', displayName));
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

const EFFORT_LABELS_ES: Record<EffortLevel, string> = {
  low: 'Bajo',
  medium: 'Medio',
  high: 'Alto',
};

export interface EffectiveEffortResolution {
  effectiveEffort: EffortLevel;
  supported: boolean;
  wasAdjusted: boolean;
  warningMessage?: string;
}

export function resolveEffectiveEffortForModel(
  modelId: string,
  requestedEffort: EffortLevel,
  provider: ProviderType = 'vertex',
): EffectiveEffortResolution {
  const def = getModelDefinition(modelId, provider);
  if (def.supportedEfforts.length === 0) {
    return {
      effectiveEffort: requestedEffort,
      supported: false,
      wasAdjusted: false,
    };
  }
  if (def.supportedEfforts.includes(requestedEffort)) {
    return {
      effectiveEffort: requestedEffort,
      supported: true,
      wasAdjusted: false,
    };
  }
  const fallback = def.defaultEffort ?? def.supportedEfforts[0]!;
  const reqEs = EFFORT_LABELS_ES[requestedEffort] ?? requestedEffort;
  const fbEs = EFFORT_LABELS_ES[fallback] ?? fallback;
  return {
    effectiveEffort: fallback,
    supported: true,
    wasAdjusted: true,
    warningMessage: `El esfuerzo guardado (${reqEs}) no es compatible con ${def.name}; se corrigió a ${fbEs} (${fallback.toUpperCase()}).`,
  };
}

export interface ApiRequestDebugEntry {
  timestamp: string;
  provider: string;
  model: string;
  effort: EffortLevel;
  thinkingParameter: string;
  subMode: string;
  includeThoughts: boolean;
  message: string;
}

const apiRequestDebugLogs: ApiRequestDebugEntry[] = [];

export function recordApiRequestDebugLog(
  entry: Omit<ApiRequestDebugEntry, 'timestamp' | 'message'> & {
    timestamp?: string;
    message?: string;
  },
): ApiRequestDebugEntry {
  const ts = entry.timestamp ?? new Date().toISOString();
  const effortEs = EFFORT_LABELS_ES[entry.effort] ?? entry.effort;
  const msg =
    entry.message ??
    `[DEBUG API] provider=${entry.provider} | model=${entry.model} | effort=${entry.effort} (${effortEs}) | param=${entry.thinkingParameter} | subMode=${entry.subMode} | thoughts=${entry.includeThoughts}`;
  const full: ApiRequestDebugEntry = {
    timestamp: ts,
    provider: entry.provider,
    model: entry.model,
    effort: entry.effort,
    thinkingParameter: entry.thinkingParameter,
    subMode: entry.subMode,
    includeThoughts: entry.includeThoughts,
    message: msg,
  };
  apiRequestDebugLogs.push(full);
  if (apiRequestDebugLogs.length > 200) {
    apiRequestDebugLogs.shift();
  }
  if (
    process.env['GLITCH_DEBUG'] === '1' ||
    process.env['GLITCH_DEBUG'] === 'true'
  ) {
    console.debug(msg);
  }
  return full;
}

export function getApiRequestDebugLogs(): readonly ApiRequestDebugEntry[] {
  return apiRequestDebugLogs;
}

export function clearApiRequestDebugLogs(): void {
  apiRequestDebugLogs.length = 0;
}

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
    const { effectiveEffort } = resolveEffectiveEffortForModel(
      modelId,
      effort,
      'vertex',
    );
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
