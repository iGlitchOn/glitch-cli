import os from 'node:os';
import type { Content, Part } from '@google/genai';
import type {
  EffortLevel,
  PermissionMode,
  SubMode,
} from '../config/settings.js';
import type {
  ApiTokenUsage,
  ProviderAdapter,
  ProviderRequestOptions,
} from '../providers/types.js';
import {
  EMPTY_API_TOKEN_USAGE,
  hasAnyApiTokenUsage,
  mergeStreamChunkUsage,
} from '../ui/statusBar.js';
import { formatCleanApiError, formatElapsedDuration } from './errorFormat.js';
import { withRetry } from './retry.js';
import type { SkillInfo } from './skills.js';
import {
  createThinkingBlockAccumulator,
  hasThinkingBlockContent,
  recordBlockSubthinking,
  recordBlockToolExecution,
  resetThinkingBlockAccumulator,
  summarizeThinkingBlock,
} from './thinkingBlocks.js';
import {
  buildGlitchSystemInstruction,
  executeGlitchToolCallAsync,
  formatToolActionSummary,
  killAllActiveShellCommands,
} from './tools.js';

export interface SubagentLogEvent {
  timestamp: number;
  kind:
    | 'subthinking'
    | 'tool_call'
    | 'tool_result'
    | 'block_summary'
    | 'correction'
    | 'status';
  text: string;
}

export type SubagentStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'limite';

export interface LiveSubagentInfo {
  id: string;
  agentIndex?: number;
  originChatTitle?: string;
  name: string;
  task: string;
  subMode: SubMode;
  round: number;
  status: SubagentStatus;
  stepCount: number;
  maxSteps: number;
  currentAction: string;
  startedAt: number;
  finishedAt?: number;
  resultPreview?: string;
  fullOutput?: string;
  log: SubagentLogEvent[];
}

export interface SubagentTaskInput {
  name?: string;
  task: string;
  sub_mode?: string;
  round?: number;
}

export interface SubagentRunOptions {
  getAdapter: () => ProviderAdapter;
  model: string;
  effort: EffortLevel;
  includeThoughts: boolean;
  parentSubMode: SubMode;
  permissionMode: PermissionMode;
  availableSkills: readonly SkillInfo[];
  initialActiveSkills?: ReadonlyMap<string, string>;
  abortSignal?: AbortSignal;
  thinkingSummaryModel?: string;
  subagentMaxSteps?: number;
  round?: number;
  originChatTitle?: string;
  onSubagentUpdate?: (info: LiveSubagentInfo) => void;
  onSubagentLog?: (message: string) => void;
  onSubAgentUsage?: (
    usage: ApiTokenUsage,
    modelId: string,
    kind?: 'tool_followup' | 'thinking_summary',
  ) => void;
}

export interface SubagentRunResult {
  id: string;
  name: string;
  round: number;
  status: 'completed' | 'failed' | 'cancelled' | 'limite';
  stepsUsed: number;
  durationText: string;
  output: string;
  error?: string;
}

export interface BackgroundSubagentHandle {
  id: string;
  name: string;
  task: string;
  round: number;
  abortController: AbortController;
  info: LiveSubagentInfo;
  inbox: string[];
  history: Content[];
  options: SubagentRunOptions;
  promise: Promise<SubagentRunResult>;
  result?: SubagentRunResult;
  consumedByParent: boolean;
  emitCancelUpdate: () => void;
  continueFromLimit: (extraSteps?: number) => Promise<SubagentRunResult>;
}

let subagentCounter = 0;
let currentRoundCounter = 0;
const activeSubagentRegistry = new Map<string, BackgroundSubagentHandle>();

export function nextSubagentId(): string {
  subagentCounter += 1;
  return `subagent-${subagentCounter}`;
}

export function nextSubagentRound(): number {
  currentRoundCounter += 1;
  return currentRoundCounter;
}

export function getActiveSubagentHandles(): ReadonlyMap<
  string,
  BackgroundSubagentHandle
> {
  return activeSubagentRegistry;
}

export function getSubagentHandleById(
  id: string,
): BackgroundSubagentHandle | undefined {
  return activeSubagentRegistry.get(id);
}

export function getRunningSubagents(): BackgroundSubagentHandle[] {
  return Array.from(activeSubagentRegistry.values()).filter(
    (h) => h.info.status === 'running',
  );
}

export function clearSubagentRegistry(): void {
  activeSubagentRegistry.clear();
}

export function sendSubagentCorrection(
  id: string,
  correctionText: string,
): boolean {
  const clean = correctionText.trim();
  if (!clean) return false;
  const handle = activeSubagentRegistry.get(id);
  if (!handle) return false;
  handle.inbox.push(clean);
  handle.info.log.push({
    timestamp: Date.now(),
    kind: 'correction',
    text: `Corrección del usuario: ${clean}`,
  });
  handle.options.onSubagentUpdate?.({
    ...handle.info,
    log: [...handle.info.log],
  });
  return true;
}

export function continueSubagentFromLimit(
  id: string,
  extraSteps = 20,
): Promise<SubagentRunResult> | null {
  const handle = activeSubagentRegistry.get(id);
  if (!handle || handle.info.status !== 'limite') {
    return null;
  }
  return handle.continueFromLimit(extraSteps);
}

export function relaunchSubagentWithCorrection(
  id: string,
  correctionText: string,
): BackgroundSubagentHandle | null {
  const handle = activeSubagentRegistry.get(id);
  if (!handle) return null;
  const nextRound = nextSubagentRound();
  const combinedTask = `${handle.task}\n\n[Corrección prioritaria del usuario]: ${correctionText.trim()}`;
  return startSubagentInBackground(
    {
      name: handle.name,
      task: combinedTask,
      sub_mode: handle.info.subMode,
      round: nextRound,
    },
    {
      ...handle.options,
      round: nextRound,
    },
  );
}

export function cancelSubagentById(id: string): boolean {
  const handle = activeSubagentRegistry.get(id);
  if (!handle) return false;
  if (handle.info.status === 'running') {
    handle.abortController.abort();
    handle.emitCancelUpdate();
    return true;
  }
  return false;
}

export function abortAllRunningSubagents(): void {
  for (const handle of activeSubagentRegistry.values()) {
    if (handle.info.status === 'running') {
      handle.abortController.abort();
      handle.emitCancelUpdate();
    }
  }
  killAllActiveShellCommands();
}

export function buildSubagentSystemInstruction(
  agentName: string,
  subMode: SubMode,
  activeSkillContents: readonly string[],
  availableSkills: readonly SkillInfo[],
): string {
  const baseInstruction = buildGlitchSystemInstruction(
    subMode,
    activeSkillContents,
    availableSkills,
    false,
  );
  const subagentHeader = [
    `=== ROL DE SUBAGENTE AUTÓNOMO: ${agentName} ===`,
    `Estás ejecutándote como un Subagente autónomo en paralelo dentro de Glitch CLI.`,
    `Reglas críticas de Subagente:`,
    `1. Tienes tu propio contexto aislado y acceso directo a las herramientas del sistema (${subMode === 'plan' ? 'list_directory, read_file, grep_search, activate_skill, cerrar_bloque' : 'list_directory, read_file, write_file, edit_file, delete_file, grep_search, run_shell_command, activate_skill, cerrar_bloque'}).`,
    `2. NO llames a ask_user ni delegues en otros subagentes (spawn_subagent / spawn_parallel_subagents): ejecuta tú mismo la tarea asignada de principio a fin.`,
    `3. Al terminar, entrega un reporte final claro, completo y estructurado con los hallazgos, acciones realizadas y resultados obtenidos para el agente principal.`,
  ].join(os.EOL);

  return `${subagentHeader}${os.EOL}${os.EOL}${baseInstruction}`;
}

export function startSubagentInBackground(
  input: SubagentTaskInput,
  options: SubagentRunOptions,
): BackgroundSubagentHandle {
  const id = nextSubagentId();
  const agentIndex = Math.max(0, subagentCounter - 1);
  const name = (input.name ?? '').trim() || `Agente #${agentIndex}`;
  const task = (input.task ?? '').trim();
  const round = input.round ?? options.round ?? Math.max(1, currentRoundCounter || nextSubagentRound());
  const requestedSubMode: SubMode =
    input.sub_mode?.toLowerCase() === 'plan' ? 'plan' : 'agent';
  const effectiveSubMode: SubMode =
    options.parentSubMode === 'plan' ? 'plan' : requestedSubMode;

  // 0 = sin límite de pasos por defecto
  let configuredMaxSteps =
    typeof options.subagentMaxSteps === 'number' && options.subagentMaxSteps > 0
      ? Math.floor(options.subagentMaxSteps)
      : 0;

  const startedAt = Date.now();
  const info: LiveSubagentInfo = {
    id,
    agentIndex,
    originChatTitle: options.originChatTitle,
    name,
    task,
    subMode: effectiveSubMode,
    round,
    status: 'running',
    stepCount: 0,
    maxSteps: configuredMaxSteps,
    currentAction: 'Iniciando subagente...',
    startedAt,
    log: [],
  };

  let abortController = new AbortController();
  const inbox: string[] = [];
  const subHistory: Content[] = task
    ? [{ role: 'user', parts: [{ text: task }] }]
    : [];
  const localActiveSkills = new Map<string, string>(
    options.initialActiveSkills
      ? Array.from(options.initialActiveSkills.entries())
      : [],
  );

  let lastEmitTs = 0;
  const emitUpdate = (patch: Partial<LiveSubagentInfo>, force = false) => {
    Object.assign(info, patch);
    const isTerminal =
      info.status !== 'running' || force;
    const now = Date.now();
    if (isTerminal || now - lastEmitTs >= 80) {
      lastEmitTs = now;
      options.onSubagentUpdate?.({ ...info, log: [...info.log] });
    }
  };

  const appendLog = (kind: SubagentLogEvent['kind'], text: string) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    info.log.push({ timestamp: Date.now(), kind, text: clean });
  };

  // Mutex por subagente para que un solo run_shell_command corra a la vez dentro de un Promise.all
  let shellChain: Promise<void> = Promise.resolve();
  const runWithShellMutex = async <T>(fn: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const nextGate = new Promise<void>((res) => {
      release = res;
    });
    const prevGate = shellChain;
    shellChain = prevGate.then(() => nextGate);
    await prevGate;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const runLoopFromStep = async (
    startStepIdx: number,
  ): Promise<SubagentRunResult> => {
    const subAbortSignal = abortController.signal;

    if (!task) {
      emitUpdate(
        {
          status: 'failed',
          finishedAt: Date.now(),
          currentAction: 'Error: tarea vacía',
        },
        true,
      );
      return {
        id,
        name,
        round,
        status: 'failed',
        stepsUsed: 0,
        durationText: '0s',
        output: '',
        error: 'Se requiere un parámetro "task" no vacío para spawn_subagent.',
      };
    }

    emitUpdate({ status: 'running', finishedAt: undefined }, true);
    if (startStepIdx === 0) {
      options.onSubagentLog?.(
        `[${name}] Subagente iniciado (modo: ${effectiveSubMode.toUpperCase()})`,
      );
    }

    const subBlockAcc = createThinkingBlockAccumulator();
    const closeSubagentBlock = async (titulo: string) => {
      const snapshot = {
        subthinkings: [...subBlockAcc.subthinkings],
        commands: [...subBlockAcc.commands],
        toolRoundsInBlock: subBlockAcc.toolRoundsInBlock,
      };
      resetThinkingBlockAccumulator(subBlockAcc);
      const sumRes = await summarizeThinkingBlock({
        titulo,
        acc: snapshot,
        adapter: options.getAdapter(),
        summaryModel: options.thinkingSummaryModel,
        abortSignal: subAbortSignal,
      });
      if (sumRes.usage) {
        options.onSubAgentUsage?.(
          sumRes.usage,
          sumRes.modelId,
          'thinking_summary',
        );
      }
      appendLog('block_summary', `[${titulo}] ${sumRes.summaryText}`);
      emitUpdate({}, true);
    };

    try {
      let finalReplyText = info.fullOutput ?? '';
      let step = startStepIdx;

      while (configuredMaxSteps === 0 || step < configuredMaxSteps) {
        if (subAbortSignal.aborted) {
          const elapsed = formatElapsedDuration(Date.now() - startedAt);
          emitUpdate(
            {
              status: 'cancelled',
              finishedAt: Date.now(),
              currentAction: 'Cancelado con ESC',
            },
            true,
          );
          return {
            id,
            name,
            round,
            status: 'cancelled',
            stepsUsed: step,
            durationText: elapsed,
            output: finalReplyText || '[Subagente cancelado con ESC]',
            error: 'Cancelado por el usuario (ESC).',
          };
        }

        // Bandeja de entrada: antes de cada paso revisa si hay correcciones pendientes y las agrega con prioridad
        if (inbox.length > 0) {
          const pendingCorrections = inbox.splice(0);
          const prioText = pendingCorrections
            .map((c) => `[CORRECCIÓN PRIORITARIA DEL USUARIO]: ${c}`)
            .join(os.EOL);
          const lastTurn = subHistory.at(-1);
          if (lastTurn && lastTurn.role === 'user') {
            lastTurn.parts = [...(lastTurn.parts ?? []), { text: prioText }];
          } else {
            subHistory.push({
              role: 'user',
              parts: [{ text: prioText }],
            });
          }
        }

        emitUpdate({
          stepCount: step + 1,
          maxSteps: configuredMaxSteps,
          currentAction:
            configuredMaxSteps > 0
              ? `Pensando (paso ${step + 1}/${configuredMaxSteps})...`
              : `Pensando (paso ${step + 1})...`,
        });

        const collectedParts: Part[] = [];
        let stepText = '';
        let attemptUsage: ApiTokenUsage = { ...EMPTY_API_TOKEN_USAGE };
        let sawUsage = false;

        await withRetry(
          async () => {
            collectedParts.length = 0;
            stepText = '';
            attemptUsage = { ...EMPTY_API_TOKEN_USAGE };
            sawUsage = false;

            const adapter = options.getAdapter();
            const reqOptions: ProviderRequestOptions = {
              model: options.model,
              effort: options.effort,
              includeThoughts: options.includeThoughts,
              subMode: effectiveSubMode,
              permissionMode: options.permissionMode,
              abortSignal: subAbortSignal,
              enableTools: true,
              systemInstruction: buildSubagentSystemInstruction(
                name,
                effectiveSubMode,
                Array.from(localActiveSkills.values()),
                options.availableSkills,
              ),
            };

            for await (const chunk of adapter.streamTurn(
              subHistory,
              reqOptions,
            )) {
              if (subAbortSignal.aborted) {
                break;
              }
              if (chunk.usage) {
                sawUsage = true;
                attemptUsage = mergeStreamChunkUsage(attemptUsage, chunk.usage);
              }
              if (chunk.rawParts && chunk.rawParts.length > 0) {
                collectedParts.push(...chunk.rawParts);
              }
              if (chunk.text) {
                stepText += chunk.text;
              }
            }
          },
          {
            maxRetries: 5,
            baseDelayMs: 600,
            abortSignal: subAbortSignal,
            onRetry: (attempt) => {
              if (sawUsage && hasAnyApiTokenUsage(attemptUsage)) {
                options.onSubAgentUsage?.(attemptUsage, options.model);
                attemptUsage = { ...EMPTY_API_TOKEN_USAGE };
                sawUsage = false;
              }
              emitUpdate({
                currentAction: `Reconectando tras fallo de red (intento ${attempt}/5)...`,
              });
            },
          },
        );

        if (sawUsage && hasAnyApiTokenUsage(attemptUsage)) {
          options.onSubAgentUsage?.(attemptUsage, options.model);
        }

        if (subAbortSignal.aborted) {
          const elapsed = formatElapsedDuration(Date.now() - startedAt);
          emitUpdate(
            {
              status: 'cancelled',
              finishedAt: Date.now(),
              currentAction: 'Cancelado con ESC',
            },
            true,
          );
          return {
            id,
            name,
            round,
            status: 'cancelled',
            stepsUsed: step + 1,
            durationText: elapsed,
            output: finalReplyText || '[Subagente cancelado con ESC]',
            error: 'Cancelado por el usuario (ESC).',
          };
        }

        if (stepText.trim()) {
          finalReplyText = stepText.trim();
          info.fullOutput = finalReplyText;
        }

        const functionCallParts = collectedParts.filter((p) =>
          Boolean(p.functionCall?.name),
        );

        if (functionCallParts.length === 0) {
          subHistory.push({
            role: 'model',
            parts:
              collectedParts.length > 0
                ? collectedParts
                : [{ text: finalReplyText || '(tarea completada)' }],
          });
          const elapsed = formatElapsedDuration(Date.now() - startedAt);
          const preview = (finalReplyText || 'reporte entregado')
            .replace(/\s+/g, ' ')
            .slice(0, 120);
          appendLog('status', `reporte entregado (${elapsed})`);
          emitUpdate(
            {
              status: 'completed',
              finishedAt: Date.now(),
              currentAction: 'reporte entregado',
              resultPreview: preview,
              fullOutput: finalReplyText || '(tarea completada)',
            },
            true,
          );
          options.onSubagentLog?.(
            `[${name}] listo en ${elapsed} (${step + 1} pasos)`,
          );
          return {
            id,
            name,
            round,
            status: 'completed',
            stepsUsed: step + 1,
            durationText: elapsed,
            output:
              finalReplyText || '(Subagente finalizó sin texto adicional)',
          };
        }

        subHistory.push({
          role: 'model',
          parts: collectedParts,
        });

        if (stepText.trim()) {
          recordBlockSubthinking(subBlockAcc, stepText.trim());
          appendLog('subthinking', stepText.trim());
        }

        let closedBlockInSubRound = false;

        const responseParts: Part[] = await Promise.all(
          functionCallParts.map(async (part) => {
            const fc = part.functionCall!;
            const toolName = fc.name ?? '';
            const toolArgs = (fc.args ?? {}) as Record<string, unknown>;

            if (subAbortSignal.aborted) {
              return {
                functionResponse: {
                  id: fc.id,
                  name: toolName,
                  response: { error: 'cancelado por el usuario' },
                },
              };
            }

            if (toolName === 'cerrar_bloque') {
              closedBlockInSubRound = true;
              const titulo =
                typeof toolArgs['titulo'] === 'string' &&
                toolArgs['titulo'].trim()
                  ? toolArgs['titulo'].trim()
                  : 'bloque de subagente';
              await closeSubagentBlock(titulo);
              return {
                functionResponse: {
                  id: fc.id,
                  name: 'cerrar_bloque',
                  response: { result: 'bloque cerrado' },
                },
              };
            }

            const actionSummary = formatToolActionSummary(toolName, toolArgs);
            appendLog('tool_call', actionSummary);
            emitUpdate({
              currentAction: actionSummary,
            });
            options.onSubagentLog?.(`  [${name}] ${actionSummary}`);

            if (
              toolName === 'spawn_subagent' ||
              toolName === 'spawn_parallel_subagents' ||
              toolName === 'esperar_subagentes'
            ) {
              return {
                functionResponse: {
                  id: fc.id,
                  name: toolName,
                  response: {
                    error:
                      'Ya eres un subagente; ejecuta las herramientas directamente sin anidar más subagentes.',
                  },
                },
              };
            }

            const execTool = () =>
              executeGlitchToolCallAsync(
                toolName,
                toolArgs,
                options.permissionMode,
                effectiveSubMode,
                options.availableSkills,
                (skill) => {
                  localActiveSkills.set(skill.name, skill.content);
                },
                false,
                subAbortSignal,
              );

            // Un solo run_shell_command a la vez por subagente
            const outcome =
              toolName === 'run_shell_command'
                ? await runWithShellMutex(execTool)
                : await execTool();

            const shortOutcome = outcome.error
              ? `error: ${outcome.error.slice(0, 80)}`
              : (outcome.result ?? 'listo').slice(0, 80);
            appendLog('tool_result', `${toolName}: ${shortOutcome}`);

            recordBlockToolExecution(subBlockAcc, {
              name: toolName,
              summary: actionSummary,
              result: outcome.result,
              error: outcome.error,
              ok: !outcome.error,
            });

            return {
              functionResponse: {
                id: fc.id,
                name: toolName,
                response: outcome.error
                  ? { error: outcome.error }
                  : { result: outcome.result ?? '' },
              },
            };
          }),
        );

        if (!closedBlockInSubRound) {
          subBlockAcc.toolRoundsInBlock += 1;
          if (
            subBlockAcc.toolRoundsInBlock >= 6 &&
            hasThinkingBlockContent(subBlockAcc) &&
            !subAbortSignal.aborted
          ) {
            await closeSubagentBlock('avance de subagente');
          }
        }

        subHistory.push({
          role: 'user',
          parts: responseParts,
        });
        step += 1;
      }

      // Si hay límite configurado y el subagente lo agota -> estado 'limite', nunca 'completed'
      const elapsed = formatElapsedDuration(Date.now() - startedAt);
      const limitNote =
        finalReplyText ||
        `(se pidió parar a ${configuredMaxSteps})`;
      appendLog('status', `limite alcanzado (${configuredMaxSteps} pasos)`);
      emitUpdate(
        {
          status: 'limite',
          finishedAt: Date.now(),
          currentAction: `(se pidió parar a ${configuredMaxSteps})`,
          resultPreview: limitNote.replace(/\s+/g, ' ').slice(0, 120),
          fullOutput: limitNote,
        },
        true,
      );
      options.onSubagentLog?.(
        `[${name}] limite alcanzado (${configuredMaxSteps} pasos, ${elapsed})`,
      );
      return {
        id,
        name,
        round,
        status: 'limite',
        stepsUsed: configuredMaxSteps,
        durationText: elapsed,
        output: limitNote,
      };
    } catch (err) {
      const elapsed = formatElapsedDuration(Date.now() - startedAt);
      const cleanErr = formatCleanApiError(err);
      const isCancelled = subAbortSignal.aborted;
      appendLog(
        'status',
        isCancelled ? 'cancelado con ESC' : `error: ${cleanErr.slice(0, 80)}`,
      );
      emitUpdate(
        {
          status: isCancelled ? 'cancelled' : 'failed',
          finishedAt: Date.now(),
          currentAction: isCancelled
            ? 'Cancelado con ESC'
            : `Error: ${cleanErr.slice(0, 80)}`,
        },
        true,
      );
      if (!isCancelled) {
        options.onSubagentLog?.(`[${name}] error: ${cleanErr}`);
      }
      return {
        id,
        name,
        round,
        status: isCancelled ? 'cancelled' : 'failed',
        stepsUsed: info.stepCount,
        durationText: elapsed,
        output: '',
        error: isCancelled ? 'Cancelado por el usuario (ESC).' : cleanErr,
      };
    }
  };

  const handle: BackgroundSubagentHandle = {
    id,
    name,
    task,
    round,
    abortController,
    info,
    inbox,
    history: subHistory,
    options,
    promise: Promise.resolve(null as unknown as SubagentRunResult),
    consumedByParent: false,
    emitCancelUpdate: () => {
      if (info.status === 'running') {
        emitUpdate(
          {
            status: 'cancelled',
            finishedAt: Date.now(),
            currentAction: 'Cancelado con ESC',
          },
          true,
        );
      }
    },
    continueFromLimit: (extraSteps = 20) => {
      abortController = new AbortController();
      handle.abortController = abortController;
      configuredMaxSteps =
        configuredMaxSteps > 0 ? configuredMaxSteps + Math.max(1, extraSteps) : 0;
      handle.consumedByParent = false;
      handle.result = undefined;
      handle.promise = runLoopFromStep(info.stepCount).then((res) => {
        handle.result = res;
        return res;
      });
      return handle.promise;
    },
  };

  handle.promise = runLoopFromStep(0).then((res) => {
    handle.result = res;
    return res;
  });

  activeSubagentRegistry.set(id, handle);
  return handle;
}

export async function waitForSubagents(
  ids: readonly string[] | undefined,
  waitOpts?: {
    abortSignal?: AbortSignal;
    interruptSignal?: AbortSignal;
    handles?: readonly BackgroundSubagentHandle[];
  },
): Promise<{
  interruptedByUserCorrection: boolean;
  abortedByEsc: boolean;
  results: SubagentRunResult[];
}> {
  const candidateHandles: BackgroundSubagentHandle[] = [];
  if (ids && ids.length > 0) {
    for (const rawId of ids) {
      const cleanId = rawId.trim();
      const h =
        activeSubagentRegistry.get(cleanId) ??
        waitOpts?.handles?.find(
          (item) => item.id === cleanId || item.name === cleanId,
        );
      if (h) candidateHandles.push(h);
    }
  } else if (waitOpts?.handles && waitOpts.handles.length > 0) {
    candidateHandles.push(
      ...waitOpts.handles.filter((h) => !h.consumedByParent),
    );
  } else {
    for (const h of activeSubagentRegistry.values()) {
      if (!h.consumedByParent) {
        candidateHandles.push(h);
      }
    }
  }

  if (candidateHandles.length === 0) {
    return {
      interruptedByUserCorrection: false,
      abortedByEsc: false,
      results: [],
    };
  }

  const abortSignal = waitOpts?.abortSignal;
  const interruptSignal = waitOpts?.interruptSignal;

  if (abortSignal?.aborted) {
    abortAllRunningSubagents();
    return {
      interruptedByUserCorrection: false,
      abortedByEsc: true,
      results: [],
    };
  }
  if (interruptSignal?.aborted) {
    return {
      interruptedByUserCorrection: true,
      abortedByEsc: false,
      results: [],
    };
  }

  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      if (abortSignal) abortSignal.removeEventListener('abort', onEscAbort);
      if (interruptSignal) {
        interruptSignal.removeEventListener('abort', onUserCorrectionInterrupt);
      }
    };

    const onEscAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      abortAllRunningSubagents();
      resolve({
        interruptedByUserCorrection: false,
        abortedByEsc: true,
        results: [],
      });
    };

    const onUserCorrectionInterrupt = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        interruptedByUserCorrection: true,
        abortedByEsc: false,
        results: [],
      });
    };

    if (abortSignal) {
      abortSignal.addEventListener('abort', onEscAbort, { once: true });
    }
    if (interruptSignal) {
      interruptSignal.addEventListener('abort', onUserCorrectionInterrupt, {
        once: true,
      });
    }

    Promise.all(candidateHandles.map((h) => h.promise))
      .then((results) => {
        if (settled) return;
        settled = true;
        cleanup();
        for (const h of candidateHandles) {
          h.consumedByParent = true;
        }
        resolve({
          interruptedByUserCorrection: false,
          abortedByEsc: false,
          results,
        });
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          interruptedByUserCorrection: false,
          abortedByEsc: Boolean(abortSignal?.aborted),
          results: candidateHandles
            .map((h) => h.result)
            .filter((r): r is SubagentRunResult => Boolean(r)),
        });
      });
  });
}

export function drainCompletedUnconsumedSubagents(
  handles?: readonly BackgroundSubagentHandle[],
): SubagentRunResult[] {
  const list = handles ?? Array.from(activeSubagentRegistry.values());
  const ready: SubagentRunResult[] = [];
  for (const h of list) {
    if (!h.consumedByParent && h.result !== undefined) {
      h.consumedByParent = true;
      ready.push(h.result);
    }
  }
  return ready;
}

export async function runSubagentTask(
  input: SubagentTaskInput,
  options: SubagentRunOptions,
): Promise<SubagentRunResult> {
  const handle = startSubagentInBackground(input, options);
  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      handle.abortController.abort();
      handle.emitCancelUpdate();
    } else {
      options.abortSignal.addEventListener(
        'abort',
        () => {
          handle.abortController.abort();
          handle.emitCancelUpdate();
        },
        { once: true },
      );
    }
  }
  const res = await handle.promise;
  handle.consumedByParent = true;
  return res;
}

export async function runParallelSubagents(
  inputs: readonly SubagentTaskInput[],
  options: SubagentRunOptions,
): Promise<SubagentRunResult[]> {
  const round = nextSubagentRound();
  return Promise.all(
    inputs.map((inp) => runSubagentTask({ ...inp, round }, { ...options, round })),
  );
}

export function formatSubagentOutcomeForModel(res: SubagentRunResult): string {
  const statusLabel =
    res.status === 'limite'
      ? 'LIMITE (alcanzó el límite de pasos configurado)'
      : res.status.toUpperCase();
  const header = `=== Subagente: ${res.name} (${res.id}) | Ronda: ${res.round} | Estado: ${statusLabel} | Pasos: ${res.stepsUsed} | Tiempo: ${res.durationText} ===`;
  if (res.error) {
    return `${header}${os.EOL}Error: ${res.error}${res.output ? `${os.EOL}Salida parcial:${os.EOL}${res.output}` : ''}`;
  }
  return `${header}${os.EOL}${res.output}`;
}
