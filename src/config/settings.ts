import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getModelDefinition } from './models.js';

export type ProviderType = 'vertex' | 'custom';
export type CustomEndpointFormat = 'chat_completions' | 'responses';
export type EffortLevel = 'low' | 'medium' | 'high';
export type PermissionMode = 'always_allow' | 'ask_insecure' | 'always_ask';
export type SubMode = 'plan' | 'agent';
export type AppLanguage = 'es' | 'en';

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  always_allow: 'Always Allow',
  ask_insecure: 'Ask only insecure',
  always_ask: 'Always Ask',
};

export function formatPermissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODE_LABELS[mode] ?? 'Always Allow';
}

export function formatSubModeLabel(
  subMode: SubMode,
  lang: AppLanguage = 'es',
): string {
  if (subMode === 'plan') return 'Plan';
  return lang === 'es' ? 'Agente' : 'Agent';
}

export interface VertexConfig {
  project: string;
  location: string;
}

export interface CustomApiConfig {
  baseUrl: string;
  apiKey: string;
  format: CustomEndpointFormat;
}

export interface GlitchSettings {
  provider?: ProviderType;
  vertex?: VertexConfig;
  custom?: CustomApiConfig;
  model: string;
  effort: EffortLevel;
  thoughts: boolean;
  permissionMode: PermissionMode;
  subMode: SubMode;
  hideDaaWarning?: boolean;
  language?: AppLanguage;
}

export const DEFAULT_SETTINGS: GlitchSettings = {
  model: 'gemini-4-argon',
  effort: 'medium',
  thoughts: true,
  permissionMode: 'always_allow',
  subMode: 'agent',
  hideDaaWarning: false,
  language: 'es',
};

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

  const merged: GlitchSettings = {
    ...DEFAULT_SETTINGS,
    ...loaded,
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
