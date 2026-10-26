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

/**
 * Estima el costo en USD de un turno a partir de los caracteres de entrada y salida
 * (~4 caracteres por token; tarifas de referencia Gemini Pro/Argon: $1.25 / 1M input, $10.00 / 1M output+thought).
 */
export function estimateTurnCostUsd(
  inputChars: number,
  outputChars: number,
  thoughtChars = 0,
): number {
  const inputTokens = Math.ceil(Math.max(0, inputChars) / 4);
  const outputTokens = Math.ceil(Math.max(0, outputChars + thoughtChars) / 4);
  const inputCost = (inputTokens / 1_000_000) * 1.25;
  const outputCost = (outputTokens / 1_000_000) * 10.0;
  return inputCost + outputCost;
}

export function formatUsdAmount(amount: number): string {
  if (amount <= 0) {
    return '$0.00';
  }
  if (amount < 0.01) {
    return `$${amount.toFixed(4)}`;
  }
  return `$${amount.toFixed(2)}`;
}

/**
 * Formatea el resumen de costo de la sesión y del último mensaje al estilo Claude Code:
 * `$0.27 | last $0.16 · 4s`
 */
export function formatSessionCostSummary(
  totalCostUsd: number,
  lastCostUsd: number,
  lastDurationText: string,
  lang: 'es' | 'en' = 'es',
): string {
  const totalStr = formatUsdAmount(totalCostUsd);
  const lastStr = formatUsdAmount(lastCostUsd);
  const dur = lastDurationText || '0s';
  const lastLabel = lang === 'en' ? 'last' : 'último';
  return `${totalStr} | ${lastLabel} ${lastStr} · ${dur}`;
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
