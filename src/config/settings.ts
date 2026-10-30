import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GEMINI_CONTEXT_WINDOW,
  getModelDefinition,
} from './models.js';

export function getAppVersion(): string {
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url);
    const raw = fs.readFileSync(pkgUrl, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // Fallback al directorio actual si aplica
  }
  try {
    const fallbackPath = path.resolve(process.cwd(), 'package.json');
    const raw = fs.readFileSync(fallbackPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // Ignorar
  }
  return '0.3.0';
}

export const APP_VERSION = getAppVersion();

export type ProviderType = 'vertex' | 'custom';
export type CustomEndpointFormat = 'chat_completions' | 'responses';
export type EffortLevel = 'low' | 'medium' | 'high';
export type PermissionMode = 'always_allow' | 'ask_insecure' | 'always_ask';
export type SubMode = 'plan' | 'agent';
export type ThinkingDisplayMode = 'expandido' | 'contraido' | 'auto';

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  always_allow: 'Always Allow',
  ask_insecure: 'Ask only insecure',
  always_ask: 'Always Ask',
};

export function formatPermissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODE_LABELS[mode] ?? 'Always Allow';
}

export function formatSubModeLabel(subMode: SubMode): string {
  if (subMode === 'plan') return 'Plan';
  return 'Agente';
}

export function notifyUnchanged(
  nombre: string,
  valor: string,
  out?: (msg: string) => void,
): string {
  const key = nombre.trim().toLowerCase();
  let message: string;
  if (
    key === 'effort' ||
    key === 'esfuerzo' ||
    key === 'el esfuerzo' ||
    key === 'esfuerzo por defecto'
  ) {
    message = `El esfuerzo ya está en ${valor}.`;
  } else if (key === 'model' || key === 'modelo' || key === 'el modelo') {
    message = `El modelo ya es ${valor}.`;
  } else if (
    key === 'permissionmode' ||
    key === 'modo' ||
    key === 'modo de permisos' ||
    key === 'el modo de permisos'
  ) {
    message = `El modo de permisos ya está en ${valor}.`;
  } else if (
    key === 'submode' ||
    key === 'sub-modo' ||
    key === 'submodo' ||
    key === 'el sub-modo'
  ) {
    message = `El sub-modo ya está en ${valor}.`;
  } else if (key === 'thoughts' || key === 'pensamientos') {
    message = `Thoughts ya está en ${valor}.`;
  } else if (
    key === 'daawarning' ||
    key === 'advertencia --daa' ||
    key === 'advertencia --daa al inicio' ||
    key === 'la advertencia --daa'
  ) {
    message = `La advertencia --DAA ya está en ${valor}.`;
  } else if (
    key === 'allowagentquestions' ||
    key === 'ask_user' ||
    key === 'preguntas de la ia' ||
    key === 'las preguntas de la ia'
  ) {
    message = `Las preguntas de la IA ya están en ${valor}.`;
  } else if (
    key === 'autocompact' ||
    key === 'autocompactación' ||
    key === 'autocompactacion' ||
    key === 'la autocompactación'
  ) {
    message = `La autocompactación ya está en ${valor}.`;
  } else if (
    key === 'autocompactthreshold' ||
    key === 'umbral' ||
    key === 'umbral de autocompactación' ||
    key === 'umbral de autocompactacion' ||
    key === 'el umbral de autocompactación'
  ) {
    message = `El umbral de autocompactación ya está en ${valor}.`;
  } else {
    message = `${nombre.trim()} ya está en ${valor}.`;
  }
  out?.(message);
  return message;
}

export function isUnchangedNoticeText(text: string): boolean {
  const clean = text.trim();
  return (
    !clean.includes('\n') &&
    (/\bya está en\b/i.test(clean) ||
      /\bya están en\b/i.test(clean) ||
      /\bya es\b/i.test(clean))
  );
}

export function formatEffortValueEs(effort: EffortLevel): string {
  if (effort === 'low') return 'Bajo';
  if (effort === 'medium') return 'Medio';
  return 'Alto';
}

export function resolveEffortAlias(raw: string): EffortLevel | null {
  const clean = raw.trim().toLowerCase();
  if (!clean) return null;
  if (
    clean === 'low' ||
    clean === 'l' ||
    clean === 'bajo' ||
    clean === 'baja' ||
    clean === 'min'
  ) {
    return 'low';
  }
  if (
    clean === 'medium' ||
    clean === 'med' ||
    clean === 'mid' ||
    clean === 'm' ||
    clean === 'medio' ||
    clean === 'media' ||
    clean === 'normal'
  ) {
    return 'medium';
  }
  if (
    clean === 'high' ||
    clean === 'hi' ||
    clean === 'h' ||
    clean === 'alto' ||
    clean === 'alta' ||
    clean === 'max'
  ) {
    return 'high';
  }
  return null;
}

export function resolvePermissionModeAlias(raw: string): PermissionMode | null {
  const clean = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!clean) return null;
  if (
    clean === '1' ||
    clean === 'always_allow' ||
    clean === 'always allow' ||
    clean === 'always-allow' ||
    clean === 'allow' ||
    clean === 'siempre permitir' ||
    clean === 'permitir siempre' ||
    clean === 'daa'
  ) {
    return 'always_allow';
  }
  if (
    clean === '2' ||
    clean === 'ask_insecure' ||
    clean === 'ask only insecure' ||
    clean === 'ask-insecure' ||
    clean === 'insecure' ||
    clean === 'solo inseguras' ||
    clean === 'preguntar inseguras'
  ) {
    return 'ask_insecure';
  }
  if (
    clean === '3' ||
    clean === 'always_ask' ||
    clean === 'always ask' ||
    clean === 'always-ask' ||
    clean === 'ask' ||
    clean === 'siempre preguntar' ||
    clean === 'preguntar siempre'
  ) {
    return 'always_ask';
  }
  return null;
}

export function resolveSubModeAlias(raw: string): SubMode | null {
  const clean = raw.trim().toLowerCase();
  if (!clean) return null;
  if (clean === '1' || clean === 'plan' || clean === 'planear') {
    return 'plan';
  }
  if (
    clean === '2' ||
    clean === 'agent' ||
    clean === 'agente' ||
    clean === 'auto'
  ) {
    return 'agent';
  }
  return null;
}

export function resolveBooleanSettingAlias(raw: string): boolean | null {
  const clean = raw.trim().toLowerCase();
  if (!clean) return null;
  if (
    clean === 'on' ||
    clean === 'true' ||
    clean === '1' ||
    clean === 'si' ||
    clean === 'sí' ||
    clean === 'activar' ||
    clean === 'activado' ||
    clean === 'activada' ||
    clean === 'activados' ||
    clean === 'activadas' ||
    clean === 'enabled'
  ) {
    return true;
  }
  if (
    clean === 'off' ||
    clean === 'false' ||
    clean === '0' ||
    clean === 'no' ||
    clean === 'desactivar' ||
    clean === 'desactivado' ||
    clean === 'desactivada' ||
    clean === 'desactivados' ||
    clean === 'desactivadas' ||
    clean === 'disabled'
  ) {
    return false;
  }
  return null;
}

export interface VertexConfig {
  project: string;
  location: string;
}

export interface CustomApiConfig {
  baseUrl: string;
  apiKey: string;
  format: CustomEndpointFormat;
  contextWindow?: number;
}

export const MODEL_MAX_CONTEXT_TOKENS = DEFAULT_GEMINI_CONTEXT_WINDOW;
export const CURRENT_PRICING_VERSION = 2;

export type ModelPricingStatusTag = 'estimado' | 'legado' | 'sin verificar';

export interface ModelPricingDateSpan {
  /** Fecha ISO de inicio de vigencia (ej. "2026-12-01") */
  desde: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cachePerMillion: number;
  tierThresholdTokens?: number;
  overThresholdInputPerMillion?: number;
  overThresholdOutputPerMillion?: number;
  overThresholdCachePerMillion?: number;
  note?: string;
}

export interface ModelPricingEntry {
  inputPerMillion: number;
  outputPerMillion: number;
  cachePerMillion: number;
  tierThresholdTokens?: number;
  overThresholdInputPerMillion?: number;
  overThresholdOutputPerMillion?: number;
  overThresholdCachePerMillion?: number;
  statusTag?: ModelPricingStatusTag;
  tramos?: ModelPricingDateSpan[];
}

export type ModelPricingTable = Record<string, ModelPricingEntry>;

export const DEFAULT_MODEL_PRICING: ModelPricingTable = {
  'gemini-4-argon': {
    inputPerMillion: 2.0,
    outputPerMillion: 10.0,
    cachePerMillion: 0.1,
    tramos: [
      {
        desde: '2026-12-01',
        inputPerMillion: 4.0,
        outputPerMillion: 20.0,
        cachePerMillion: 0.2,
        note: 'caché estimada',
      },
    ],
  },
  'gemini-4-argon-cyber-permissive': {
    inputPerMillion: 2.0,
    outputPerMillion: 10.0,
    cachePerMillion: 0.1,
    tramos: [
      {
        desde: '2026-12-01',
        inputPerMillion: 4.0,
        outputPerMillion: 20.0,
        cachePerMillion: 0.2,
        note: 'caché estimada',
      },
    ],
  },
  'gemini-3.1-pro-preview': {
    inputPerMillion: 2.0,
    outputPerMillion: 12.0,
    cachePerMillion: 0.2,
    tierThresholdTokens: 200_000,
    overThresholdInputPerMillion: 4.0,
    overThresholdOutputPerMillion: 18.0,
    overThresholdCachePerMillion: 0.4,
  },
  'gemini-3-pro-preview': {
    inputPerMillion: 2.0,
    outputPerMillion: 12.0,
    cachePerMillion: 0.2,
    tierThresholdTokens: 200_000,
    overThresholdInputPerMillion: 4.0,
    overThresholdOutputPerMillion: 18.0,
    overThresholdCachePerMillion: 0.4,
    statusTag: 'estimado',
  },
  'gemini-2.5-pro': {
    inputPerMillion: 1.25,
    outputPerMillion: 10.0,
    cachePerMillion: 0.125,
    tierThresholdTokens: 200_000,
    overThresholdInputPerMillion: 2.5,
    overThresholdOutputPerMillion: 15.0,
    overThresholdCachePerMillion: 0.25,
  },
  'gemini-3-flash-preview': {
    inputPerMillion: 0.5,
    outputPerMillion: 3.0,
    cachePerMillion: 0.05,
  },
  'gemini-3.1-flash-lite-preview': {
    inputPerMillion: 0.25,
    outputPerMillion: 1.5,
    cachePerMillion: 0.025,
  },
  'gemini-2.5-flash': {
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    cachePerMillion: 0.03,
  },
  'gemini-2.5-flash-lite': {
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
    cachePerMillion: 0.01,
    statusTag: 'legado',
  },
  'gemini-2.0-flash': {
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
    cachePerMillion: 0.025,
    statusTag: 'sin verificar',
  },
  'gemini-2.0-flash-lite': {
    inputPerMillion: 0.075,
    outputPerMillion: 0.3,
    cachePerMillion: 0.01875,
    statusTag: 'sin verificar',
  },
};

export function cloneDefaultModelPricing(): ModelPricingTable {
  const out: ModelPricingTable = {};
  for (const [k, v] of Object.entries(DEFAULT_MODEL_PRICING)) {
    out[k] = {
      ...v,
      ...(v.tramos ? { tramos: v.tramos.map((t) => ({ ...t })) } : {}),
    };
  }
  return out;
}

export function resolveModelPricingForDate(
  entry: ModelPricingEntry,
  referenceDate: Date | string = new Date(),
): ModelPricingEntry {
  if (!entry.tramos || entry.tramos.length === 0) {
    return entry;
  }
  const isoDate =
    typeof referenceDate === 'string'
      ? referenceDate.slice(0, 10)
      : referenceDate.toISOString().slice(0, 10);

  let matchedSpan: ModelPricingDateSpan | undefined;
  for (const span of entry.tramos) {
    const spanDate = span.desde.trim().slice(0, 10);
    if (spanDate <= isoDate) {
      if (!matchedSpan || spanDate >= matchedSpan.desde.trim().slice(0, 10)) {
        matchedSpan = span;
      }
    }
  }

  if (!matchedSpan) {
    return entry;
  }

  return {
    ...entry,
    inputPerMillion: matchedSpan.inputPerMillion,
    outputPerMillion: matchedSpan.outputPerMillion,
    cachePerMillion: matchedSpan.cachePerMillion,
    tierThresholdTokens: matchedSpan.tierThresholdTokens,
    overThresholdInputPerMillion: matchedSpan.overThresholdInputPerMillion,
    overThresholdOutputPerMillion: matchedSpan.overThresholdOutputPerMillion,
    overThresholdCachePerMillion: matchedSpan.overThresholdCachePerMillion,
  };
}

export function migrateModelPricing(
  loadedPricing: ModelPricingTable | undefined,
  pricingEditedModels: readonly string[] | undefined,
): { pricingTable: ModelPricingTable; editedModels: string[] } {
  const fresh = cloneDefaultModelPricing();
  const edited = Array.isArray(pricingEditedModels)
    ? pricingEditedModels.filter((m) => typeof m === 'string' && m.trim().length > 0)
    : [];

  if (!loadedPricing || edited.length === 0) {
    return { pricingTable: fresh, editedModels: [] };
  }

  for (const modelId of edited) {
    const userEntry = loadedPricing[modelId];
    if (userEntry && typeof userEntry === 'object') {
      fresh[modelId] = { ...userEntry };
    }
  }

  return { pricingTable: fresh, editedModels: [...new Set(edited)] };
}

export interface GlitchSettings {
  provider?: ProviderType;
  vertex?: VertexConfig;
  custom?: CustomApiConfig;
  model: string;
  effort: EffortLevel;
  thoughts: boolean;
  thinkingDisplay?: ThinkingDisplayMode;
  thinkingSummaryModel?: string;
  subagentMaxSteps?: number;
  permissionMode: PermissionMode;
  subMode: SubMode;
  hideDaaWarning?: boolean;
  allowAgentQuestions?: boolean;
  autoCompact?: boolean;
  autoCompactThreshold?: number;
  modelPricing?: ModelPricingTable;
  pricingVersion?: number;
  pricingEditedModels?: string[];
  regionalSurchargePct?: number;
  toggleThoughtsShortcut?: string;
  tuiMode?: 'default' | 'fullscreen';
}

export const DEFAULT_SETTINGS: GlitchSettings = {
  model: 'gemini-4-argon',
  effort: 'medium',
  thoughts: true,
  thinkingDisplay: 'expandido',
  thinkingSummaryModel: 'gemini-3.1-pro-preview',
  subagentMaxSteps: 0,
  permissionMode: 'always_allow',
  subMode: 'agent',
  hideDaaWarning: false,
  allowAgentQuestions: true,
  autoCompact: true,
  autoCompactThreshold: 70,
  modelPricing: cloneDefaultModelPricing(),
  pricingVersion: CURRENT_PRICING_VERSION,
  pricingEditedModels: [],
  regionalSurchargePct: 0,
  toggleThoughtsShortcut: 'ctrl+t',
  tuiMode: 'default',
};

export function applyModelPriceEdit(
  currentSettings: GlitchSettings,
  modelId: string,
  prices: {
    inputPerMillion: number;
    outputPerMillion: number;
    cachePerMillion: number;
  },
  customHomeDir?: string,
): GlitchSettings {
  const cleanModel = modelId.trim();
  const currentTable = {
    ...(currentSettings.modelPricing ?? cloneDefaultModelPricing()),
  };
  const existingEntry = currentTable[cleanModel] ?? {
    inputPerMillion: prices.inputPerMillion,
    outputPerMillion: prices.outputPerMillion,
    cachePerMillion: prices.cachePerMillion,
  };
  currentTable[cleanModel] = {
    ...existingEntry,
    inputPerMillion: prices.inputPerMillion,
    outputPerMillion: prices.outputPerMillion,
    cachePerMillion: prices.cachePerMillion,
  };
  const editedSet = new Set(currentSettings.pricingEditedModels ?? []);
  editedSet.add(cleanModel);

  const updated: GlitchSettings = {
    ...currentSettings,
    modelPricing: currentTable,
    pricingVersion: CURRENT_PRICING_VERSION,
    pricingEditedModels: Array.from(editedSet),
  };
  saveSettings(updated, customHomeDir);
  return updated;
}

export function validateAutoCompactThreshold(
  rawInput: string | number,
): { valid: true; value: number } | { valid: false; error: string } {
  const str = String(rawInput).trim().replace(/%$/, '').trim();
  if (!/^\d+$/.test(str)) {
    return {
      valid: false,
      error:
        'Umbral inválido: solo se permiten enteros de 10 a 95 (sin decimales).',
    };
  }
  const num = Number.parseInt(str, 10);
  if (!Number.isInteger(num) || num < 10 || num > 95) {
    return {
      valid: false,
      error:
        'Umbral fuera de rango: el rango válido es de 10 a 95 (solo enteros).',
    };
  }
  return { valid: true, value: num };
}

export function hasAlwaysAllowFlag(argv: readonly string[]): boolean {
  return argv.some((arg) => {
    const clean = arg.trim();
    return (
      clean === '--DAA' ||
      clean === '--daa' ||
      clean === '-DAA' ||
      clean === '--DDA' ||
      clean === '--dda' ||
      clean === '-AA' ||
      clean === '--aa' ||
      clean === '--AA' ||
      clean === '--dangerously-always-allow'
    );
  });
}

export function parseModelFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]?.trim() ?? '';
    if ((arg === '--model' || arg === '-m') && i + 1 < argv.length) {
      const val = argv[i + 1]?.trim().replace(/^["']|["']$/g, '');
      if (val && !val.startsWith('-')) {
        return val;
      }
    }
    if (arg.startsWith('--model=')) {
      const val = arg
        .slice('--model='.length)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (val) return val;
    }
    if (arg.startsWith('-m=')) {
      const val = arg.slice('-m='.length).trim().replace(/^["']|["']$/g, '');
      if (val) return val;
    }
  }
  return undefined;
}

function isKnownNonMessageCliFlag(token: string): boolean {
  const clean = token.trim();
  return (
    clean === '--DAA' ||
    clean === '--daa' ||
    clean === '-DAA' ||
    clean === '--DDA' ||
    clean === '--dda' ||
    clean === '-AA' ||
    clean === '--aa' ||
    clean === '--AA' ||
    clean === '--dangerously-always-allow' ||
    clean === '--model' ||
    clean === '-m' ||
    clean.startsWith('--model=') ||
    clean.startsWith('-m=') ||
    clean === '--version' ||
    clean === '-v' ||
    clean === '--help' ||
    clean === '-h' ||
    clean === '--same-window' ||
    clean === '--in-window' ||
    clean === '--m' ||
    clean === '--message' ||
    clean.startsWith('--m=') ||
    clean.startsWith('--message=')
  );
}

export function hasSameWindowFlag(argv: readonly string[]): boolean {
  return argv.some((arg) => {
    const clean = arg.trim();
    return clean === '--same-window' || clean === '--in-window';
  });
}

export function parseMessageFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]?.trim() ?? '';
    if (arg === '--m' || arg === '--message') {
      const tokens: string[] = [];
      for (let j = i + 1; j < argv.length; j++) {
        const nextTok = argv[j] ?? '';
        if (isKnownNonMessageCliFlag(nextTok)) {
          break;
        }
        tokens.push(nextTok);
      }
      const joined = tokens.join(' ').trim().replace(/^["']|["']$/g, '').trim();
      if (joined) return joined;
    }
    if (arg.startsWith('--message=')) {
      const first = arg.slice('--message='.length);
      const tokens = [first];
      for (let j = i + 1; j < argv.length; j++) {
        const nextTok = argv[j] ?? '';
        if (isKnownNonMessageCliFlag(nextTok)) break;
        tokens.push(nextTok);
      }
      const joined = tokens.join(' ').trim().replace(/^["']|["']$/g, '').trim();
      if (joined) return joined;
    }
    if (arg.startsWith('--m=')) {
      const first = arg.slice('--m='.length);
      const tokens = [first];
      for (let j = i + 1; j < argv.length; j++) {
        const nextTok = argv[j] ?? '';
        if (isKnownNonMessageCliFlag(nextTok)) break;
        tokens.push(nextTok);
      }
      const joined = tokens.join(' ').trim().replace(/^["']|["']$/g, '').trim();
      if (joined) return joined;
    }
  }
  return undefined;
}

export function getSettingsPath(customHomeDir?: string): string {
  const home = customHomeDir ?? os.homedir();
  return path.join(home, '.glitch', 'settings.json');
}

export function maskApiKey(apiKey: string | undefined): string {
  if (!apiKey || apiKey.trim().length === 0) {
    return '(vacía)';
  }
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) {
    return '****';
  }
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`;
}

export function loadSettings(
  customHomeDir?: string,
  argv: readonly string[] = [],
): GlitchSettings {
  const filePath = getSettingsPath(customHomeDir);
  let loaded: Partial<GlitchSettings> = {};

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      loaded = JSON.parse(raw) as Partial<GlitchSettings>;
    } catch {
      loaded = {};
    }
  }

  const envProject = process.env['GOOGLE_CLOUD_PROJECT'];
  const envLocation = process.env['GOOGLE_CLOUD_LOCATION'];

  const vertex =
    loaded.vertex ??
    (envProject && envLocation
      ? { project: envProject, location: envLocation }
      : undefined);

  const { pricingTable, editedModels } = migrateModelPricing(
    loaded.modelPricing,
    loaded.pricingEditedModels,
  );

  const merged: GlitchSettings = {
    ...DEFAULT_SETTINGS,
    ...loaded,
    modelPricing: pricingTable,
    pricingVersion: CURRENT_PRICING_VERSION,
    pricingEditedModels: editedModels,
    regionalSurchargePct:
      typeof loaded.regionalSurchargePct === 'number' &&
      !Number.isNaN(loaded.regionalSurchargePct)
        ? Math.max(0, loaded.regionalSurchargePct)
        : 0,
    ...(vertex ? { vertex } : {}),
  };

  if (hasAlwaysAllowFlag(argv)) {
    merged.permissionMode = 'always_allow';
  }

  const cliModel = parseModelFlag(argv);
  if (cliModel) {
    const def = getModelDefinition(cliModel, merged.provider ?? 'vertex');
    merged.model = def.id;
    if (
      def.supportedEfforts.length > 0 &&
      !def.supportedEfforts.includes(merged.effort)
    ) {
      merged.effort = def.defaultEffort ?? def.supportedEfforts[0]!;
    }
  }

  return merged;
}

export function saveSettings(
  settings: GlitchSettings,
  customHomeDir?: string,
): void {
  const filePath = getSettingsPath(customHomeDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export function isAuthConfigured(settings: GlitchSettings): boolean {
  if (settings.provider === 'vertex') {
    return Boolean(
      settings.vertex?.project?.trim() && settings.vertex?.location?.trim(),
    );
  }
  if (settings.provider === 'custom') {
    return Boolean(
      settings.custom?.baseUrl?.trim() &&
        settings.custom?.apiKey?.trim() &&
        settings.custom?.format,
    );
  }
  return false;
}

export function formatAuthSummary(settings: GlitchSettings): string {
  if (settings.provider === 'vertex' && settings.vertex) {
    return `Vertex AI (proyecto: ${settings.vertex.project}, región: ${settings.vertex.location}, ADC)`;
  }
  if (settings.provider === 'custom' && settings.custom) {
    return `API personalizada (${settings.custom.baseUrl}, formato: ${settings.custom.format}, key: ${maskApiKey(settings.custom.apiKey)})`;
  }
  return 'No configurado';
}
