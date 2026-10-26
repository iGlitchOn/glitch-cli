import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Content } from '@google/genai';
import { getModelDefinition } from '../config/models.js';
import {
  formatPermissionModeLabel,
  formatSubModeLabel,
  type GlitchSettings,
} from '../config/settings.js';

export function formatStatusBar(settings: GlitchSettings): string {
  const provider = settings.provider ?? 'vertex';
  const lang = settings.language ?? 'es';
  const def = getModelDefinition(settings.model, provider);
  const effortLabel =
    def.supportedEfforts.length > 0
      ? (def.supportedEfforts.includes(settings.effort)
          ? settings.effort
          : (def.defaultEffort ?? def.supportedEfforts[0]!)
        ).toUpperCase()
      : 'N/A';

  if (lang === 'en') {
    return `Model: ${def.name} | Effort: ${effortLabel}`;
  }
  return `Modelo: ${def.name} | Esfuerzo: ${effortLabel}`;
}

export function formatInputTopLeftMode(settings: GlitchSettings): string {
  const lang = settings.language ?? 'es';
  const modeLabel = formatPermissionModeLabel(settings.permissionMode);
  const subModeLabel = formatSubModeLabel(settings.subMode, lang);
  const subTitle = lang === 'en' ? 'Sub-Mode' : 'Sub-Modo';
  return `${modeLabel} · ${subTitle}: ${subModeLabel} (Shift+Tab)`;
}

export function calculateRemainingContextPercent(
  history: readonly Content[],
  maxTokens = 1_000_000,
): number {
  let totalChars = 0;
  for (const turn of history) {
    for (const part of turn.parts ?? []) {
      if (part.text) {
        totalChars += part.text.length;
      }
    }
  }
  const estimatedUsedTokens = Math.ceil(totalChars / 4);
  const remainingRatio = Math.max(
    0,
    Math.min(1, (maxTokens - estimatedUsedTokens) / maxTokens),
  );
  return Math.round(remainingRatio * 100);
}

export function detectEnvironmentCounts(customHomeDir?: string): {
  mcpCount: number;
  skillCount: number;
} {
  const home = customHomeDir ?? os.homedir();
  let mcpCount = 0;
  let skillCount = 0;

  const skillsDir = path.join(home, '.agents', 'skills');
  if (fs.existsSync(skillsDir)) {
    try {
      skillCount = fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory()).length;
    } catch {
      skillCount = 0;
    }
  }

  const settingsPath = path.join(home, '.glitch', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const mcpServers = raw['mcpServers'];
      if (mcpServers && typeof mcpServers === 'object') {
        mcpCount = Object.keys(mcpServers).length;
      }
    } catch {
      mcpCount = 0;
    }
  }

  return { mcpCount, skillCount };
}

export function formatInputTopRightInfo(
  history: readonly Content[],
  mcpCount = 0,
  skillCount = 0,
  lang: 'es' | 'en' = 'es',
): string {
  const pct = calculateRemainingContextPercent(history);
  if (lang === 'en') {
    return `${pct}% context left · ${mcpCount} active MCPs · ${skillCount} skills`;
  }
  return `${pct}% contexto restante · ${mcpCount} MCP activos · ${skillCount} skills`;
}
