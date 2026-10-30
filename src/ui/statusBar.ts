import type { Content } from '@google/genai';
import stringWidth from 'string-width';
import {
  DEFAULT_GEMINI_CONTEXT_WINDOW,
  getModelContextWindow,
  getModelDefinition,
  resolveEffectiveEffortForModel,
} from '../config/models.js';
import {
  formatPermissionModeLabel,
  formatSubModeLabel,
  type GlitchSettings,
} from '../config/settings.js';
import {
  discoverMcpServers,
  type McpServerEntry,
} from '../core/mcpRegistry.js';
import { discoverSkills, type SkillInfo } from '../core/skills.js';
import {
  GLITCH_TOOL_DECLARATIONS,
  buildGlitchSystemInstruction,
} from '../core/tools.js';
import { formatEffortDisplayLabel } from './banner.js';
import {
  formatChatTotalAmount,
  formatUsdAmount,
} from './costCalculator.js';

export * from './costCalculator.js';

export interface ContextUsageBreakdown {
  maxTokens: number;
  baseSystemTokens: number;
  toolSchemaTokens: number;
  mcpTokens: number;
  skillsCatalogTokens: number;
  activeSkillsTokens: number;
  historyTextTokens: number;
  historyThoughtTokens: number;
  historyToolCallTokens: number;
  apiReportedPromptTokens: number | null;
  totalUsedTokens: number;
  remainingTokens: number;
  usedPercent: number;
  remainingPercent: number;
}

export function computeConsistentContextPercentages(
  usedTokens: number,
  maxTokens = DEFAULT_GEMINI_CONTEXT_WINDOW,
): {
  clampedUsed: number;
  remainingTokens: number;
  usedPercent: number;
  remainingPercent: number;
} {
  const safeMax = Math.max(1, maxTokens);
  const clampedUsed = Math.max(0, usedTokens);
  const remainingTokens = Math.max(0, safeMax - clampedUsed);

  if (clampedUsed <= 0) {
    return {
      clampedUsed: 0,
      remainingTokens: safeMax,
      usedPercent: 0,
      remainingPercent: 100,
    };
  }
  if (clampedUsed >= safeMax) {
    return {
      clampedUsed,
      remainingTokens: 0,
      usedPercent: 100,
      remainingPercent: 0,
    };
  }

  const rawFreePct = (remainingTokens / safeMax) * 100;
  const remainingPercent = Math.min(99, Math.max(0, Math.floor(rawFreePct)));
  const usedPercent = Math.max(1, 100 - remainingPercent);

  return {
    clampedUsed,
    remainingTokens,
    usedPercent,
    remainingPercent,
  };
}

export function computeContextUsageBreakdown(
  history: readonly Content[],
  subMode: 'plan' | 'agent' = 'agent',
  availableSkills: readonly SkillInfo[] = [],
  activeSkillContents: readonly string[] = [],
  maxTokens = DEFAULT_GEMINI_CONTEXT_WINDOW,
  mcpServers?: readonly McpServerEntry[],
  apiReportedPromptTokens: number | null = null,
): ContextUsageBreakdown {
  const baseSysPrompt = buildGlitchSystemInstruction(subMode, [], []);
  const baseSystemTokens = Math.ceil(baseSysPrompt.length / 4);

  const toolSchemaJson = JSON.stringify(GLITCH_TOOL_DECLARATIONS);
  const toolSchemaTokens = Math.ceil(toolSchemaJson.length / 4);

  const resolvedMcps = mcpServers ?? discoverMcpServers();
  const mcpSchemaChars = resolvedMcps.reduce((acc, m) => {
    const cmdsJson = JSON.stringify(m.commands);
    return (
      acc +
      m.id.length +
      m.description.length +
      m.commandLine.length +
      cmdsJson.length +
      120
    );
  }, 0);
  const mcpTokens = Math.ceil(mcpSchemaChars / 3);

  const withCatalogPrompt = buildGlitchSystemInstruction(
    subMode,
    [],
    availableSkills,
  );
  const skillsCatalogChars = Math.max(
    0,
    withCatalogPrompt.length - baseSysPrompt.length,
  );
  const skillsCatalogTokens = Math.ceil(skillsCatalogChars / 4);

  const activeSkillsChars = activeSkillContents.reduce(
    (acc, content) => acc + content.length,
    0,
  );
  const activeSkillsTokens = Math.ceil(activeSkillsChars / 4);

  let historyTextChars = 0;
  let historyThoughtChars = 0;
  let historyToolChars = 0;

  for (const turn of history) {
    for (const part of turn.parts ?? []) {
      const rec = part as Record<string, unknown>;
      const isThought =
        Boolean(rec['thought']) ||
        rec['type'] === 'thinking' ||
        rec['type'] === 'reasoning' ||
        typeof rec['thinking'] === 'string' ||
        typeof rec['reasoning'] === 'string';

      if (isThought) {
        const tStr =
          part.text ??
          (typeof rec['thinking'] === 'string'
            ? rec['thinking']
            : typeof rec['reasoning'] === 'string'
              ? rec['reasoning']
              : '');
        historyThoughtChars += tStr.length;
      } else if (part.text) {
        historyTextChars += part.text.length;
      }

      if (part.functionCall) {
        historyToolChars += JSON.stringify(part.functionCall).length;
      }
      if (part.functionResponse) {
        historyToolChars += JSON.stringify(part.functionResponse).length;
      }
    }
  }

  const historyTextTokens = Math.ceil(historyTextChars / 4);
  const historyThoughtTokens = Math.ceil(historyThoughtChars / 4);
  const historyToolCallTokens = Math.ceil(historyToolChars / 4);

  const computedTotal =
    baseSystemTokens +
    toolSchemaTokens +
    mcpTokens +
    skillsCatalogTokens +
    activeSkillsTokens +
    historyTextTokens +
    historyThoughtTokens +
    historyToolCallTokens;

  const authoritativeUsed =
    typeof apiReportedPromptTokens === 'number' && apiReportedPromptTokens > 0
      ? apiReportedPromptTokens
      : computedTotal;

  const { clampedUsed, remainingTokens, usedPercent, remainingPercent } =
    computeConsistentContextPercentages(authoritativeUsed, maxTokens);

  return {
    maxTokens,
    baseSystemTokens,
    toolSchemaTokens,
    mcpTokens,
    skillsCatalogTokens,
    activeSkillsTokens,
    historyTextTokens,
    historyThoughtTokens,
    historyToolCallTokens,
    apiReportedPromptTokens:
      typeof apiReportedPromptTokens === 'number' && apiReportedPromptTokens > 0
        ? apiReportedPromptTokens
        : null,
    totalUsedTokens: clampedUsed,
    remainingTokens,
    usedPercent,
    remainingPercent,
  };
}

export function formatStatusBar(
  settings: GlitchSettings,
  onMismatchWarning?: (msg: string) => void,
): string {
  const provider = settings.provider ?? 'vertex';
  const def = getModelDefinition(
    settings.model,
    provider,
    undefined,
    settings.custom,
  );
  const resolution = resolveEffectiveEffortForModel(
    settings.model,
    settings.effort,
    provider,
  );

  if (resolution.wasAdjusted) {
    settings.effort = resolution.effectiveEffort;
    if (resolution.warningMessage) {
      onMismatchWarning?.(resolution.warningMessage);
    }
  }

  const effortLabel = resolution.supported
    ? formatEffortDisplayLabel(resolution.effectiveEffort)
    : 'N/A';

  return `${def.name} | Esfuerzo: ${effortLabel}`;
}

export function formatInputTopLeftMode(
  settings: GlitchSettings,
  totalCostUsd?: number | null,
): string {
  const modeLabel = formatPermissionModeLabel(settings.permissionMode);
  const subModeLabel = formatSubModeLabel(settings.subMode);
  const base = `${modeLabel} · Sub-Modo: ${subModeLabel}`;
  if (totalCostUsd === undefined) {
    return base;
  }
  return `${base} · Total: ${formatChatTotalAmount(totalCostUsd)}`;
}

export function formatInputTopLeftWithTotal(
  settings: GlitchSettings,
  totalCostUsd: number | null,
  rightSideText = '',
  terminalColumns = process.stdout.columns ?? 100,
): string {
  const baseStr = formatInputTopLeftMode(settings);
  const totalStr = formatChatTotalAmount(totalCostUsd);
  const fullCandidate = `${baseStr} · Total: ${totalStr}`;
  const shortCandidate = `${baseStr} · Tot: ${totalStr}`;

  const rightW = stringWidth(rightSideText);
  const maxLeftWidth = Math.max(0, terminalColumns - rightW - 6);

  if (stringWidth(fullCandidate) <= maxLeftWidth) {
    return fullCandidate;
  }
  if (stringWidth(shortCandidate) <= maxLeftWidth) {
    return shortCandidate;
  }
  return baseStr;
}

export function formatThinkingStatusLine(
  elapsedText: string,
  _turnCostUsd?: number | null,
): string {
  const dur = elapsedText || '0s';
  return `Pensando ${dur}  esc para cancelar`;
}

export function formatSessionCostSummary(
  totalCostUsd: number | null,
  lastCostUsd: number | null,
  lastDurationText: string,
): string {
  const totalStr = formatUsdAmount(totalCostUsd);
  const lastStr = formatUsdAmount(lastCostUsd);
  const dur = lastDurationText || '0s';
  return `${totalStr} | último ${lastStr} · ${dur}`;
}

export function calculateRemainingContextPercent(
  history: readonly Content[],
  maxTokens = DEFAULT_GEMINI_CONTEXT_WINDOW,
): number {
  const breakdown = computeContextUsageBreakdown(
    history,
    'agent',
    [],
    [],
    maxTokens,
  );
  return breakdown.remainingPercent;
}

export function detectEnvironmentCounts(
  activeMcpServers: readonly McpServerEntry[] = [],
  activeSkillNames: readonly string[] = [],
): {
  mcpCount: number;
  skillCount: number;
} {
  const connectedMcps = activeMcpServers.filter((m) => Boolean(m.active));
  return {
    mcpCount: connectedMcps.length,
    skillCount: activeSkillNames.length,
  };
}

export function formatMaxContextWindowLabel(
  maxTokens = DEFAULT_GEMINI_CONTEXT_WINDOW,
): string {
  if (maxTokens >= 1_000_000) {
    return '1M';
  }
  return `${Math.round(maxTokens / 1000)}k`;
}

export function formatContextShortBarLabel(
  usedTokens: number,
  maxTokens = DEFAULT_GEMINI_CONTEXT_WINDOW,
): string {
  const clampedUsed = Math.max(0, usedTokens);
  const kTokens = (clampedUsed / 1000).toFixed(1);
  const maxLabel = formatMaxContextWindowLabel(maxTokens);
  return `context: ${kTokens}k / ${maxLabel}`;
}

export function formatBarUsdCompact(costUsd: number): string {
  const dollar = String.fromCharCode(36);
  if (costUsd > 0 && costUsd < 0.01) {
    return `${dollar}${costUsd.toFixed(4)}`;
  }
  return `${dollar}${costUsd.toFixed(2)}`;
}

export interface TelemetryStatusBarParams {
  usedTokens: number;
  maxTokens?: number;
  activeMcpCount?: number;
  activeSkillCount?: number;
  costUsd?: number | null;
  unknownPriceCount?: number;
}

export function formatTelemetryStatusBarLine(
  params: TelemetryStatusBarParams,
): string {
  const maxTokens = params.maxTokens ?? DEFAULT_GEMINI_CONTEXT_WINDOW;
  const segments: string[] = [
    formatContextShortBarLabel(params.usedTokens, maxTokens),
  ];

  const mcpCount = Math.max(0, Math.floor(params.activeMcpCount ?? 0));
  if (mcpCount > 0) {
    segments.push(`${mcpCount} MCP`);
  }

  const skillCount = Math.max(0, Math.floor(params.activeSkillCount ?? 0));
  if (skillCount > 0) {
    segments.push(skillCount === 1 ? '1 SKILL' : `${skillCount} SKILLS`);
  }

  const cost = params.costUsd;
  const unknownCount = Math.max(0, Math.floor(params.unknownPriceCount ?? 0));
  if (typeof cost === 'number' && !Number.isNaN(cost) && cost > 0) {
    const baseCostStr = formatBarUsdCompact(cost);
    segments.push(
      unknownCount > 0
        ? `${baseCostStr} (+${unknownCount} sin precio)`
        : baseCostStr,
    );
  } else if (unknownCount > 0) {
    segments.push('sin precio');
  }

  return segments.join(' . ');
}

export function formatInputTopRightInfo(
  history: readonly Content[],
  mcpCount = 0,
  skillCount = 0,
  extraTokens = 0,
  apiReportedPromptTokens: number | null = null,
  maxTokens = DEFAULT_GEMINI_CONTEXT_WINDOW,
  costUsd?: number | null,
  unknownPriceCount = 0,
): string {
  let totalUsedTokens: number;

  if (
    typeof apiReportedPromptTokens === 'number' &&
    apiReportedPromptTokens > 0
  ) {
    totalUsedTokens = apiReportedPromptTokens;
  } else if (extraTokens > 0) {
    let historyChars = 0;
    for (const turn of history) {
      for (const part of turn.parts ?? []) {
        const rec = part as Record<string, unknown>;
        const thoughtStr =
          typeof rec['thinking'] === 'string'
            ? rec['thinking']
            : typeof rec['reasoning'] === 'string'
              ? rec['reasoning']
              : '';
        if (part.text) {
          historyChars += part.text.length;
        } else if (thoughtStr) {
          historyChars += thoughtStr.length;
        }
        if (part.functionCall) {
          historyChars += JSON.stringify(part.functionCall).length;
        }
        if (part.functionResponse) {
          historyChars += JSON.stringify(part.functionResponse).length;
        }
      }
    }
    const historyTokens = Math.ceil(historyChars / 4);
    totalUsedTokens = historyTokens + Math.max(0, extraTokens);
  } else {
    const breakdown = computeContextUsageBreakdown(
      history,
      'agent',
      [],
      [],
      maxTokens,
      undefined,
      null,
    );
    totalUsedTokens = breakdown.totalUsedTokens;
  }

  return formatTelemetryStatusBarLine({
    usedTokens: totalUsedTokens,
    maxTokens,
    activeMcpCount: mcpCount,
    activeSkillCount: skillCount,
    costUsd,
    unknownPriceCount,
  });
}

export { getModelContextWindow };
