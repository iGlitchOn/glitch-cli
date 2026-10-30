import os from 'node:os';
import type { ApiTokenUsage, ProviderAdapter } from '../providers/types.js';
import {
  EMPTY_API_TOKEN_USAGE,
  hasAnyApiTokenUsage,
  mergeStreamChunkUsage,
} from '../ui/statusBar.js';

export interface BlockToolEntry {
  name: string;
  summary: string;
  result?: string;
  error?: string;
  ok: boolean;
}

export interface ThinkingBlockAccumulator {
  subthinkings: string[];
  commands: BlockToolEntry[];
  toolRoundsInBlock: number;
}

export interface ThinkingBlockSummaryEvent {
  title: string;
  summary: string;
  usedFallback: boolean;
  commandsCount: number;
}

export function createThinkingBlockAccumulator(): ThinkingBlockAccumulator {
  return {
    subthinkings: [],
    commands: [],
    toolRoundsInBlock: 0,
  };
}

export function resetThinkingBlockAccumulator(
  acc: ThinkingBlockAccumulator,
): void {
  acc.subthinkings.length = 0;
  acc.commands.length = 0;
  acc.toolRoundsInBlock = 0;
}

export function hasThinkingBlockContent(
  acc: ThinkingBlockAccumulator,
): boolean {
  return acc.commands.length > 0 || acc.subthinkings.length > 0;
}

export function recordBlockSubthinking(
  acc: ThinkingBlockAccumulator,
  text: string | undefined,
): void {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  if (acc.subthinkings.at(-1) !== clean) {
    acc.subthinkings.push(clean);
  }
}

export function recordBlockToolExecution(
  acc: ThinkingBlockAccumulator,
  entry: BlockToolEntry,
): void {
  acc.commands.push(entry);
}

export function enforceWordLimit(text: string, maxWords = 60): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const words = normalized.split(' ');
  if (words.length <= maxWords) {
    return normalized;
  }
  return `${words.slice(0, maxWords).join(' ').replace(/[.,;:]+$/, '')}.`;
}

export function formatCollapsedThoughtLine(thoughtText: string): string {
  const lines = thoughtText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines[0] ?? '';
}

export function buildDeterministicBlockSummary(
  titulo: string,
  acc: ThinkingBlockAccumulator,
): string {
  const cleanTitle = titulo.trim() || 'bloque de ejecución';
  const totalCmds = acc.commands.length;
  const failedCmds = acc.commands.filter((c) => !c.ok);
  const cmdNames = Array.from(new Set(acc.commands.map((c) => c.name))).join(
    ', ',
  );

  if (totalCmds === 0) {
    const sub = acc.subthinkings[0] ?? 'se analizó el problema';
    return enforceWordLimit(
      `En el bloque "${cleanTitle}", ${sub.toLowerCase()} y el análisis finalizó correctamente.`,
      60,
    );
  }

  if (failedCmds.length > 0) {
    const firstError = (failedCmds[0]?.error ?? 'fallo en comando')
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    return enforceWordLimit(
      `Se abordó "${cleanTitle}" ejecutando ${cmdNames} (${totalCmds} comando${totalCmds === 1 ? '' : 's'}). Ocurrió un error (${firstError}) y ${failedCmds.length === totalCmds ? 'el intento falló' : 'se completó parcialmente'}.`,
      60,
    );
  }

  return enforceWordLimit(
    `Se abordó "${cleanTitle}" ejecutando ${cmdNames} (${totalCmds} comando${totalCmds === 1 ? '' : 's'}) sin errores y el intento fue exitoso.`,
    60,
  );
}

export interface SummarizeThinkingBlockParams {
  titulo: string;
  acc: ThinkingBlockAccumulator;
  adapter: ProviderAdapter;
  summaryModel?: string;
  abortSignal?: AbortSignal;
}

export async function summarizeThinkingBlock(
  params: SummarizeThinkingBlockParams,
): Promise<{
  summaryText: string;
  usage?: ApiTokenUsage;
  modelId: string;
  usedFallback: boolean;
}> {
  const modelId =
    params.summaryModel?.trim() || 'gemini-3.1-pro-preview';
  const cleanTitle = params.titulo.trim() || 'objetivo actual';

  if (params.abortSignal?.aborted) {
    return {
      summaryText: buildDeterministicBlockSummary(cleanTitle, params.acc),
      modelId,
      usedFallback: true,
    };
  }

  const subLines =
    params.acc.subthinkings.length > 0
      ? `Intenciones previas:${os.EOL}${params.acc.subthinkings.map((s) => `- ${s}`).join(os.EOL)}`
      : '';
  const cmdLines =
    params.acc.commands.length > 0
      ? `Comandos ejecutados:${os.EOL}${params.acc.commands
          .map((c) => {
            const status = c.ok ? 'éxito' : `error (${(c.error ?? '').slice(0, 120)})`;
            const outPreview = (c.result ?? '').replace(/\s+/g, ' ').slice(0, 120);
            return `- ${c.summary} -> ${status}${outPreview ? ` | ${outPreview}` : ''}`;
          })
          .join(os.EOL)}`
      : '';

  const promptText = [
    `Objetivo del bloque: "${cleanTitle}"`,
    subLines,
    cmdLines,
    'Redacta en español, en máximo 60 palabras y con tono de historia corta (ej. "Ocurrió este error, se intentó solucionar y el intento fue exitoso"), qué ocurrió en este bloque y su resultado.',
  ]
    .filter(Boolean)
    .join(`${os.EOL}${os.EOL}`);

  let mergedUsage: ApiTokenUsage = { ...EMPTY_API_TOKEN_USAGE };
  let sawUsage = false;
  let rawOutput = '';

  try {
    for await (const chunk of params.adapter.streamTurn(
      [{ role: 'user', parts: [{ text: promptText }] }],
      {
        model: modelId,
        effort: 'low',
        includeThoughts: false,
        subMode: 'plan',
        enableTools: false,
        abortSignal: params.abortSignal,
        systemInstruction:
          'Eres un resumidor conciso de bloques de pensamiento. Redacta únicamente una historia corta en español de máximo 60 palabras explicando qué se intentó y si tuvo éxito o falló. No uses listas ni encabezados.',
      },
    )) {
      if (chunk.usage) {
        sawUsage = true;
        mergedUsage = mergeStreamChunkUsage(mergedUsage, chunk.usage);
      }
      if (chunk.text) {
        rawOutput += chunk.text;
      }
    }

    const cleaned = enforceWordLimit(rawOutput.trim(), 60);
    if (!cleaned) {
      throw new Error('Resumen vacío del modelo resumidor');
    }

    return {
      summaryText: cleaned,
      usage: sawUsage && hasAnyApiTokenUsage(mergedUsage) ? mergedUsage : undefined,
      modelId,
      usedFallback: false,
    };
  } catch {
    return {
      summaryText: buildDeterministicBlockSummary(cleanTitle, params.acc),
      usage: sawUsage && hasAnyApiTokenUsage(mergedUsage) ? mergedUsage : undefined,
      modelId,
      usedFallback: true,
    };
  }
}
