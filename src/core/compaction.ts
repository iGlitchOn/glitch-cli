import type { Content } from '@google/genai';
import { getModelContextWindow } from '../config/models.js';
import type { GlitchSettings } from '../config/settings.js';
import type { ApiTokenUsage, ProviderAdapter } from '../providers/types.js';
import {
  EMPTY_API_TOKEN_USAGE,
  computeContextUsageBreakdown,
  mergeStreamChunkUsage,
} from '../ui/statusBar.js';
import type { McpServerEntry } from './mcpRegistry.js';
import type { SkillInfo } from './skills.js';

export interface CompactionTracker {
  /** Máximo 1 intento fallido por turno para evitar bucles */
  attemptedInCurrentTurn: boolean;
  /** Evita que se dispare dos veces seguidas si tras compactar el resumen mismo sigue >= umbral */
  justCompactedAboveThreshold: boolean;
}

export function createCompactionTracker(): CompactionTracker {
  return {
    attemptedInCurrentTurn: false,
    justCompactedAboveThreshold: false,
  };
}

export function resetCompactionTrackerForNewTurn(
  tracker: CompactionTracker,
): void {
  tracker.attemptedInCurrentTurn = false;
}

export interface SavedPausedTaskState {
  currentUserPrompt: string;
  subMode: GlitchSettings['subMode'];
  model: string;
  effort: GlitchSettings['effort'];
  tailTurns: Content[];
}

export interface CompactionOutcome {
  compacted: boolean;
  usedPercentBefore: number;
  remainingPercentBefore: number;
  usedPercentAfter: number;
  remainingPercentAfter: number;
  usedTokensBefore?: number;
  usedTokensAfter?: number;
  summaryText?: string;
  chatDisplayBlock?: string;
  warningMessage?: string;
  subAgentUsage?: ApiTokenUsage;
}

function serializeHistoryForSummarizer(history: readonly Content[]): string {
  const lines: string[] = [];
  for (let i = 0; i < history.length; i++) {
    const turn = history[i]!;
    const roleLabel = turn.role === 'model' ? 'AGENTE' : 'USUARIO/SISTEMA';
    const partDescriptions: string[] = [];
    for (const p of turn.parts ?? []) {
      if ((p as Record<string, unknown>)['thought']) {
        continue;
      }
      if (p.text) {
        partDescriptions.push(p.text);
      }
      if (p.functionCall) {
        partDescriptions.push(
          `[Tool Call: ${p.functionCall.name}(${JSON.stringify(p.functionCall.args ?? {})})]`,
        );
      }
      if (p.functionResponse) {
        const rawResp = JSON.stringify(p.functionResponse.response ?? {});
        const clippedResp =
          rawResp.length > 600 ? `${rawResp.slice(0, 600)}...` : rawResp;
        partDescriptions.push(
          `[Tool Response ${p.functionResponse.name}: ${clippedResp}]`,
        );
      }
    }
    if (partDescriptions.length > 0) {
      lines.push(`Turno #${i + 1} (${roleLabel}):\n${partDescriptions.join('\n')}`);
    }
  }
  return lines.join('\n\n');
}

/**
 * Extrae los últimos 2 o 3 turnos intactos asegurándose de no dejar un `functionResponse`
 * sin su `functionCall` previo ni romper la alternancia user/model.
 */
export function extractRecentTurnsIntact(
  history: readonly Content[],
  desiredCount = 3,
): Content[] {
  if (history.length === 0) return [];
  let startIdx = Math.max(0, history.length - desiredCount);

  // Si el primer turno seleccionado es un functionResponse, incluimos el turno model anterior
  while (startIdx > 0) {
    const first = history[startIdx];
    const hasFnResponse = first?.parts?.some((p) => Boolean(p.functionResponse));
    if (hasFnResponse || first?.role === 'model') {
      startIdx--;
    } else {
      break;
    }
  }

  return history.slice(startIdx).map((t) => ({
    role: t.role,
    parts: t.parts ? t.parts.map((p) => ({ ...p })) : [],
  }));
}

export function formatCompactionChatBlock(
  usedPercent: number,
  remainingPercent: number,
  rawSummary: string,
): string {
  const clean = rawSummary
    .trim()
    .replace(/^Resumen\s*:\s*/i, '')
    .trim();
  return `Resumen por falta de contexto (contexto usado: ${usedPercent}%, restante: ${remainingPercent}%)\n\nResumen: ${clean}`;
}

export interface RunAutoCompactionOptions {
  history: Content[];
  settings: GlitchSettings;
  adapter: ProviderAdapter;
  currentUserPrompt: string;
  availableSkills: readonly SkillInfo[];
  activeSkillContents: readonly string[];
  mcpServers?: readonly McpServerEntry[];
  apiReportedPromptTokens?: number | null;
  tracker: CompactionTracker;
  maxTokens?: number;
  abortSignal?: AbortSignal;
  onCompactingStatusChange?: (isCompacting: boolean) => void;
  onSubAgentUsage?: (usage: ApiTokenUsage) => void;
}

/**
 * Revisa el porcentaje de contexto USADO antes de un turno o después de una respuesta de herramienta.
 * Si es >= umbral y la autocompactación está activa:
 * 1. Pausa temporalmente la tarea guardando el estado actual (`SavedPausedTaskState`).
 * 2. Lanza un sub-agente dedicado para resumir toda la conversación.
 * 3. Reemplaza el historial viejo por el resumen, conservando intacto el mensaje actual del usuario y los últimos 2 o 3 turnos.
 * 4. Maneja errores sin borrar el historial (máximo 1 intento por turno) y evita compactar dos veces seguidas si el resumen mismo supera el umbral.
 */
export async function maybeAutoCompactContext(
  opts: RunAutoCompactionOptions,
): Promise<CompactionOutcome> {
  const {
    history,
    settings,
    adapter,
    currentUserPrompt,
    availableSkills,
    activeSkillContents,
    mcpServers,
    apiReportedPromptTokens = null,
    tracker,
    maxTokens,
    abortSignal,
    onCompactingStatusChange,
  } = opts;

  const effectiveMaxTokens =
    maxTokens ??
    getModelContextWindow(
      settings.model,
      settings.provider ?? 'vertex',
      settings.custom,
    );

  if (abortSignal?.aborted) {
    return {
      compacted: false,
      usedPercentBefore: 0,
      remainingPercentBefore: 100,
      usedPercentAfter: 0,
      remainingPercentAfter: 100,
    };
  }

  const before = computeContextUsageBreakdown(
    history,
    settings.subMode,
    availableSkills,
    activeSkillContents,
    effectiveMaxTokens,
    mcpServers,
    apiReportedPromptTokens,
  );

  const autoCompactEnabled = settings.autoCompact ?? true;
  const threshold = settings.autoCompactThreshold ?? 70;

  if (!autoCompactEnabled || before.usedPercent < threshold) {
    if (before.usedPercent < threshold) {
      tracker.justCompactedAboveThreshold = false;
    }
    return {
      compacted: false,
      usedPercentBefore: before.usedPercent,
      remainingPercentBefore: before.remainingPercent,
      usedPercentAfter: before.usedPercent,
      remainingPercentAfter: before.remainingPercent,
      usedTokensBefore: before.totalUsedTokens,
      usedTokensAfter: before.totalUsedTokens,
    };
  }

  // Regla 7: Evitar que se dispare dos veces seguidas si el contexto resultante siguió por encima del umbral por culpa del resumen mismo
  if (tracker.justCompactedAboveThreshold) {
    tracker.justCompactedAboveThreshold = false;
    return {
      compacted: false,
      usedPercentBefore: before.usedPercent,
      remainingPercentBefore: before.remainingPercent,
      usedPercentAfter: before.usedPercent,
      remainingPercentAfter: before.remainingPercent,
      usedTokensBefore: before.totalUsedTokens,
      usedTokensAfter: before.totalUsedTokens,
      warningMessage: `El contexto resultante (${before.usedPercent}%) sigue por encima del umbral (${threshold}%) debido al tamaño del resumen. Se omite compactar dos veces seguidas.`,
    };
  }

  // Regla 6: Si ya falló en este turno, no entrar en bucle (máximo 1 intento por turno)
  if (tracker.attemptedInCurrentTurn) {
    return {
      compacted: false,
      usedPercentBefore: before.usedPercent,
      remainingPercentBefore: before.remainingPercent,
      usedPercentAfter: before.usedPercent,
      remainingPercentAfter: before.remainingPercent,
      usedTokensBefore: before.totalUsedTokens,
      usedTokensAfter: before.totalUsedTokens,
    };
  }

  // Regla 2: Guardar el estado de la tarea pausada antes de lanzar el sub-agente
  const pausedState: SavedPausedTaskState = {
    currentUserPrompt,
    subMode: settings.subMode,
    model: settings.model,
    effort: settings.effort,
    tailTurns: extractRecentTurnsIntact(history, 3),
  };

  onCompactingStatusChange?.(true);
  let subAgentUsage: ApiTokenUsage | undefined;

  try {
    const transcript = serializeHistoryForSummarizer(history);
    const subAgentSystemInstruction = [
      'Eres un sub-agente especializado en compactación de memoria y contexto para Glitch CLI.',
      'Tu única tarea es generar un resumen denso, fiel y estructurado en un solo párrafo o bloque continuo que comience con "Resumen: ".',
      'El resumen DEBE incluir obligatoriamente:',
      '1) Nombre y datos del usuario si los dio.',
      '2) Qué pidió el usuario.',
      '3) Qué se hizo hasta ahora.',
      '4) Archivos modificados o creados.',
      '5) Decisiones técnicas tomadas.',
      '6) Tareas pendientes.',
      '7) El punto exacto donde quedó el agente antes de pausarse.',
    ].join('\n');

    const subAgentPrompt = [
      `Resume toda la siguiente conversación para liberar memoria y poder reanudar la tarea actual sin perder ningún detalle importante.`,
      `Mensaje/tarea actual del usuario: "${pausedState.currentUserPrompt}"`,
      `Transcripción de la conversación:\n${transcript}`,
    ].join('\n\n');

    let summaryAcc = '';
    let mergedSubUsage: ApiTokenUsage = { ...EMPTY_API_TOKEN_USAGE };
    let sawSubUsage = false;
    for await (const chunk of adapter.streamTurn(
      [{ role: 'user', parts: [{ text: subAgentPrompt }] }],
      {
        model: pausedState.model,
        effort: pausedState.effort,
        includeThoughts: false,
        subMode: 'plan',
        enableTools: false,
        abortSignal,
        systemInstruction: subAgentSystemInstruction,
      },
    )) {
      if (abortSignal?.aborted) {
        break;
      }
      if (chunk.usage) {
        sawSubUsage = true;
        mergedSubUsage = mergeStreamChunkUsage(mergedSubUsage, chunk.usage);
        subAgentUsage = mergedSubUsage;
        opts.onSubAgentUsage?.(mergedSubUsage);
      }
      if (chunk.text) {
        summaryAcc += chunk.text;
      }
    }
    if (!sawSubUsage) {
      subAgentUsage = undefined;
    }

    if (abortSignal?.aborted) {
      return {
        compacted: false,
        usedPercentBefore: before.usedPercent,
        remainingPercentBefore: before.remainingPercent,
        usedPercentAfter: before.usedPercent,
        remainingPercentAfter: before.remainingPercent,
        usedTokensBefore: before.totalUsedTokens,
        usedTokensAfter: before.totalUsedTokens,
        subAgentUsage,
      };
    }

    const cleanSummary = summaryAcc
      .trim()
      .replace(/^Resumen\s*:\s*/i, '')
      .trim();

    if (!cleanSummary) {
      throw new Error('El sub-agente devolvió un resumen vacío.');
    }

    // Regla 4: Reemplazar el historial viejo por ese resumen. Conservar intacto el mensaje actual del usuario y los últimos 2 o 3 turnos.
    const tailHasCurrentPrompt = pausedState.tailTurns.some((t) =>
      t.parts?.some(
        (p) => typeof p.text === 'string' && p.text.includes(pausedState.currentUserPrompt),
      ),
    );

    const summaryTurnText = tailHasCurrentPrompt
      ? `[Contexto resumido automáticamente]\nResumen: ${cleanSummary}`
      : `[Contexto resumido automáticamente]\nResumen: ${cleanSummary}\n\nMensaje actual del usuario (intacto): ${pausedState.currentUserPrompt}`;

    const newHistory: Content[] = [
      {
        role: 'user',
        parts: [{ text: summaryTurnText }],
      },
      {
        role: 'model',
        parts: [
          {
            text: 'Entendido. Conservo el resumen completo de la conversación y reanudo la tarea exactamente desde el punto donde quedó.',
          },
        ],
      },
      ...pausedState.tailTurns,
    ];

    history.length = 0;
    history.push(...newHistory);

    let postCompactionApiTokens: number | null = null;
    if (adapter.countTokens) {
      postCompactionApiTokens = await adapter.countTokens(history, {
        model: settings.model,
        effort: settings.effort,
        includeThoughts: settings.thoughts,
        subMode: settings.subMode,
        enableTools: true,
      });
    }

    const after = computeContextUsageBreakdown(
      history,
      settings.subMode,
      availableSkills,
      activeSkillContents,
      effectiveMaxTokens,
      mcpServers,
      postCompactionApiTokens,
    );

    let warningMessage: string | undefined;
    if (after.usedPercent >= threshold) {
      tracker.justCompactedAboveThreshold = true;
      warningMessage = `El contexto tras compactar quedó en ${after.usedPercent}% (sigue >= al umbral de ${threshold}% por el tamaño del resumen). No se volverá a compactar seguidamente.`;
    } else {
      tracker.justCompactedAboveThreshold = false;
    }

    const chatDisplayBlock = formatCompactionChatBlock(
      before.usedPercent,
      before.remainingPercent,
      cleanSummary,
    );

    return {
      compacted: true,
      usedPercentBefore: before.usedPercent,
      remainingPercentBefore: before.remainingPercent,
      usedPercentAfter: after.usedPercent,
      remainingPercentAfter: after.remainingPercent,
      usedTokensBefore: before.totalUsedTokens,
      usedTokensAfter: after.totalUsedTokens,
      summaryText: cleanSummary,
      chatDisplayBlock,
      warningMessage,
      subAgentUsage,
    };
  } catch (err) {
    // Regla 6: Si el sub-agente falla, NO borrar el historial. Mostrar un aviso y seguir sin compactar, reintentando en el siguiente turno (máx 1 intento por turno).
    tracker.attemptedInCurrentTurn = true;
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      compacted: false,
      usedPercentBefore: before.usedPercent,
      remainingPercentBefore: before.remainingPercent,
      usedPercentAfter: before.usedPercent,
      remainingPercentAfter: before.remainingPercent,
      usedTokensBefore: before.totalUsedTokens,
      usedTokensAfter: before.totalUsedTokens,
      subAgentUsage,
      warningMessage: `Falló el sub-agente de autocompactación (${errMsg}). Se conserva el historial intacto y se reintentará en el siguiente turno.`,
    };
  } finally {
    onCompactingStatusChange?.(false);
  }
}
