import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ProviderType = 'vertex' | 'custom';
export type CustomEndpointFormat = 'chat_completions' | 'responses';
export type EffortLevel = 'low' | 'medium' | 'high';
export type PermissionMode = 'always_allow' | 'ask_insecure' | 'always_ask';
export type SubMode = 'plan' | 'agent';

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
}

export const DEFAULT_SETTINGS: GlitchSettings = {
  model: 'gemini-4-argon',
  effort: 'medium',
  thoughts: true,
  permissionMode: 'always_allow',
  subMode: 'agent',
};

export function hasAlwaysAllowFlag(argv: readonly string[]): boolean {
  return argv.some((arg) => {
    const clean = arg.trim();
    return (
      clean === '-AA' ||
      clean === '--aa' ||
      clean === '--AA' ||
      clean === '--dangerously-always-allow'
    );
  });
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
