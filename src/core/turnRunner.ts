import os from 'node:os';
import type { Content, Part } from '@google/genai';
import { recordApiRequestDebugLog } from '../config/models.js';
import type {
  ApiTokenUsage,
  ProviderAdapter,
  ProviderRequestOptions,
} from '../providers/types.js';
import {
  EMPTY_API_TOKEN_USAGE,
  buildCostRequestRecord,
  calculateApiUsageCostUsd,
  computeLastRequestContextTokens,
  formatCostAuditReport,
  hasAnyApiTokenUsage,
  hasValidModelPricing,
  mergeStreamChunkUsage,
  type CostRequestRecord,
} from '../ui/statusBar.js';
import {
  deriveSessionTitle,
  recordRequestInGlobalUsage,
} from './sessionStore.js';
import { buildUserPartsWithImages } from './clipboard.js';
import {
  createCompactionTracker,
  maybeAutoCompactContext,
  resetCompactionTrackerForNewTurn,
  type CompactionOutcome,
  type CompactionTracker,
} from './compaction.js';
import { formatCleanApiError, formatElapsedDuration } from './errorFormat.js';
import type { McpServerEntry } from './mcpRegistry.js';
import { withRetry, type RetryOptions } from './retry.js';
import type { SessionState } from './session.js';
import { discoverInstalledSkills, type SkillInfo } from './skills.js';
import {
  abortAllRunningSubagents,
  drainCompletedUnconsumedSubagents,
  formatSubagentOutcomeForModel,
  nextSubagentRound,
  startSubagentInBackground,
  waitForSubagents,
  type BackgroundSubagentHandle,
  type LiveSubagentInfo,
  type SubagentTaskInput,
} from './subagents.js';
import {
  buildDeterministicBlockSummary,
  createThinkingBlockAccumulator,
  hasThinkingBlockContent,
  recordBlockSubthinking,
  recordBlockToolExecution,
  resetThinkingBlockAccumulator,
  summarizeThinkingBlock,
  type ThinkingBlockSummaryEvent,
} from './thinkingBlocks.js';
import {
  buildGlitchSystemInstruction,
  executeGlitchToolCallAsync,
  formatToolActionSummary,
  killAllActiveShellCommands,
} from './tools.js';

export type { ThinkingBlockSummaryEvent };

export interface TurnToolStartEvent {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  summary: string;
  subthinking?: string;
}

export interface TurnToolResultEvent {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  error?: string;
  durationMs: number;
}

export interface TurnUsageEvent {
  phase: 'in_flight' | 'committed' | 'unknown_model_pricing';
  modelId: string;
  kind?: CostRequestRecord['kind'];
  usage?: ApiTokenUsage;
  record?: CostRequestRecord;
  committedTurnCostUsd: number | null;
  liveTurnCostUsd: number | null;
  turnHasUnknownCost: boolean;
  lastApiPromptTokens: number | null;
}

export interface TurnStepMessageEvent {
  text: string;
  thoughtText?: string;
  durationText: string;
  isFinal: boolean;
  isCancelled?: boolean;
}

export interface TurnRunnerCallbacks {
  onText?: (deltaText: string, accumulatedText: string) => void;
  onThought?: (deltaThought: string, accumulatedThought: string) => void;
  onStepMessage?: (msg: TurnStepMessageEvent) => void;
  onToolStart?: (ev: TurnToolStartEvent) => void;
  onToolResult?: (ev: TurnToolResultEvent) => void;
  onBlockSummary?: (ev: ThinkingBlockSummaryEvent) => void;
  onSubagentUpdate?: (info: LiveSubagentInfo) => void;
  onSubagentLog?: (logMsg: string) => void;
  onUsage?: (ev: TurnUsageEvent) => void;
  onSystemNotice?: (msg: string) => void;
  onCompactingStatusChange?: (isCompacting: boolean) => void;
  onCompactionResult?: (outcome: CompactionOutcome) => void;
  onAskUser?: (args: {
    question: string;
    header?: string;
    options: string[];
  }) => Promise<string>;
  onCancelAskUser?: () => void;
  onSkillActivated?: (
    skill: SkillInfo,
    activeSkillNames: string[],
  ) => void;
  onPersistCheckpoint?: () => void;
  onSettingsReconciled?: () => void;
  onCallConfigBuilt?: (config: ProviderRequestOptions) => void;
}

export interface TurnStepControllerRef {
  interruptCurrentStepForCorrection: (priorityUserMessage?: string) => void;
}

export interface TurnRunnerOptions extends TurnRunnerCallbacks {
  session: SessionState;
  userPrompt: string;
  getAdapter: () => ProviderAdapter;
  abortSignal?: AbortSignal;
  stepControllerRef?: TurnStepControllerRef;
  installedSkills?: readonly SkillInfo[];
  activeSkillContents?: Map<string, string>;
  mcpServers?: readonly McpServerEntry[];
  compactionTracker?: CompactionTracker;
  maxContextTokens?: number;
  retryOptions?: RetryOptions;
  customHomeDir?: string;
  referenceDate?: Date | string;
  shouldContinueTask?: (
    stepIndex: number,
    lastReplyText: string,
    session: SessionState,
  ) => Promise<boolean> | boolean;
}

export interface TurnRunnerResult {
  finalText: string;
  finalThought: string;
  durationText: string;
  aborted: boolean;
  committedTurnCostUsd: number | null;
}

/**
 * Garantiza que ningún turno 'model' en el historial quede con un functionCall sin su functionResponse.
 */
export function ensureHistoryFunctionCallsResolved(history: Content[]): void {
  if (history.length === 0) return;

  const lastIdx = history.length - 1;
  const lastTurn = history[lastIdx]!;

  if (lastTurn.role === 'model') {
    const fcParts = (lastTurn.parts ?? []).filter((p) =>
      Boolean(p.functionCall?.name),
    );
    if (fcParts.length > 0) {
      history.push({
        role: 'user',
        parts: fcParts.map((p) => ({
          functionResponse: {
            id: p.functionCall!.id,
            name: p.functionCall!.name ?? '',
            response: { error: 'cancelado por el usuario' },
          },
        })),
      });
    }
    return;
  }

  if (lastTurn.role === 'user' && lastIdx >= 1) {
    const prevTurn = history[lastIdx - 1]!;
    if (prevTurn.role === 'model') {
      const fcParts = (prevTurn.parts ?? []).filter((p) =>
        Boolean(p.functionCall?.name),
      );
      if (fcParts.length > 0) {
        const existingRespParts = lastTurn.parts ?? [];
        const hasResponseAt = (idx: number, fcId?: string, fcName?: string) => {
          if (fcId) {
            return existingRespParts.some(
              (rp) => rp.functionResponse?.id === fcId,
            );
          }
          const respAtIdx = existingRespParts[idx];
          return Boolean(
            respAtIdx?.functionResponse &&
              respAtIdx.functionResponse.name === fcName,
          );
        };
        for (let i = 0; i < fcParts.length; i++) {
          const fc = fcParts[i]!.functionCall!;
          if (!hasResponseAt(i, fc.id, fc.name)) {
            existingRespParts.push({
              functionResponse: {
                id: fc.id,
                name: fc.name ?? '',
                response: { error: 'cancelado por el usuario' },
              },
            });
          }
        }
        lastTurn.parts = existingRespParts;
      }
    }
  }
}

function injectUserTextIntoHistory(history: Content[], text: string): void {
  if (!text.trim()) return;
  const last = history.at(-1);
  if (last && last.role === 'user') {
    last.parts = [...(last.parts ?? []), { text }];
  } else {
    history.push({
      role: 'user',
      parts: [{ text }],
    });
  }
}

function raceWithSignals<T>(
  promise: Promise<T>,
  abortSignal?: AbortSignal,
  stepSignal?: AbortSignal,
): Promise<
  | { kind: 'resolved'; value: T }
  | { kind: 'aborted' }
  | { kind: 'step_interrupted' }
> {
  if (abortSignal?.aborted) {
    return Promise.resolve({ kind: 'aborted' });
  }
  if (stepSignal?.aborted) {
    return Promise.resolve({ kind: 'step_interrupted' });
  }
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      if (stepSignal) stepSignal.removeEventListener('abort', onStep);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ kind: 'aborted' });
    };
    const onStep = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ kind: 'step_interrupted' });
    };
    if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });
    if (stepSignal) stepSignal.addEventListener('abort', onStep, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ kind: 'resolved', value });
      },
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ kind: 'aborted' });
      },
    );
  });
}

export async function runSingleTurn(
  options: TurnRunnerOptions,
): Promise<TurnRunnerResult> {
  const {
    session,
    userPrompt,
    getAdapter,
    abortSignal,
    installedSkills = [],
    activeSkillContents = new Map<string, string>(),
    mcpServers = [],
    compactionTracker = createCompactionTracker(),
    maxContextTokens,
    retryOptions,
    shouldContinueTask,
  } = options;

  session.isRequestActive = true;
  resetCompactionTrackerForNewTurn(compactionTracker);
  const startTs = Date.now();

  session.history.push({
    role: 'user',
    parts: buildUserPartsWithImages(userPrompt),
  });

  let finalAccText = '';
  let finalAccThought = '';
  let committedTurnCostUsd: number | null = 0;
  let turnHasUnknownCost = false;
  let elapsed = '0s';

  const turnSubagentHandles: BackgroundSubagentHandle[] = [];
  const pendingPriorityMessages: string[] = [];
  let currentStepAbortController = new AbortController();
  const blockAcc = createThinkingBlockAccumulator();

  if (options.stepControllerRef) {
    options.stepControllerRef.interruptCurrentStepForCorrection = (
      priorityMsg?: string,
    ) => {
      if (priorityMsg && priorityMsg.trim()) {
        pendingPriorityMessages.push(priorityMsg.trim());
      }
      currentStepAbortController.abort();
    };
  }

  const onTurnAbort = () => {
    currentStepAbortController.abort();
    abortAllRunningSubagents();
    killAllActiveShellCommands();
    options.onCancelAskUser?.();
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      onTurnAbort();
    } else {
      abortSignal.addEventListener('abort', onTurnAbort, { once: true });
    }
  }

  try {
    session.turnCounter++;
    const currentTurnIdx = session.turnCounter;
    let stepInTurnIdx = 0;
    const maxStreamRetries = retryOptions?.maxRetries ?? 9;
    const baseDelayMs = retryOptions?.baseDelayMs ?? 700;

    const initialLive = session.getLiveCallConfig((warnMsg) => {
      options.onSystemNotice?.(warnMsg);
      options.onSettingsReconciled?.();
    });
    const hasInitialPrice = hasValidModelPricing(
      initialLive.model,
      session.settings.modelPricing,
      options.referenceDate,
    );
    if (!hasInitialPrice) {
      turnHasUnknownCost = true;
      committedTurnCostUsd = null;
      options.onUsage?.({
        phase: 'unknown_model_pricing',
        modelId: initialLive.model,
        committedTurnCostUsd: null,
        liveTurnCostUsd: null,
        turnHasUnknownCost: true,
        lastApiPromptTokens: session.lastApiPromptTokenCount,
      });
      options.onSystemNotice?.(
        `El modelo "${initialLive.model}" no está en la tabla de precios o tiene precio 0: se mostrará "sin precio".`,
      );
    } else {
      options.onUsage?.({
        phase: 'in_flight',
        modelId: initialLive.model,
        committedTurnCostUsd: 0,
        liveTurnCostUsd: 0,
        turnHasUnknownCost: false,
        lastApiPromptTokens: session.lastApiPromptTokenCount,
      });
    }

    const commitRequestUsageRecord = (
      stepUsage: ApiTokenUsage | undefined,
      modelId: string,
      kind: CostRequestRecord['kind'],
    ) => {
      if (!hasAnyApiTokenUsage(stepUsage)) {
        if (committedTurnCostUsd === 0 && session.costRecords.length === 0) {
          options.onUsage?.({
            phase: 'committed',
            modelId,
            kind,
            committedTurnCostUsd: null,
            liveTurnCostUsd: null,
            turnHasUnknownCost,
            lastApiPromptTokens: session.lastApiPromptTokenCount,
          });
        } else {
          options.onUsage?.({
            phase: 'committed',
            modelId,
            kind,
            committedTurnCostUsd,
            liveTurnCostUsd: committedTurnCostUsd,
            turnHasUnknownCost,
            lastApiPromptTokens: session.lastApiPromptTokenCount,
          });
        }
        return;
      }

      const rec = buildCostRequestRecord({
        requestIndex: session.costRecords.length + 1,
        turnIndex: currentTurnIdx,
        kind,
        model: modelId,
        usage: stepUsage,
        pricingTable: session.settings.modelPricing,
        referenceDate: options.referenceDate,
        regionalSurchargePct: session.settings.regionalSurchargePct,
      });
      session.costRecords.push(rec);
      recordRequestInGlobalUsage(rec, options.customHomeDir);

      const lastCtxTokens =
        rec.totalPromptTokens + rec.outputTokens + rec.reasoningTokens;
      if (lastCtxTokens > 0) {
        session.lastApiPromptTokenCount = lastCtxTokens;
      }

      if (rec.costUsd === null) {
        turnHasUnknownCost = true;
        session.unknownPriceRequestCount += 1;
        if (committedTurnCostUsd === 0) {
          committedTurnCostUsd = null;
        }
      } else {
        committedTurnCostUsd = (committedTurnCostUsd ?? 0) + rec.costUsd;
        session.sessionCostUsd = (session.sessionCostUsd ?? 0) + rec.costUsd;
      }

      options.onUsage?.({
        phase: 'committed',
        modelId,
        kind,
        usage: stepUsage,
        record: rec,
        committedTurnCostUsd,
        liveTurnCostUsd: committedTurnCostUsd,
        turnHasUnknownCost,
        lastApiPromptTokens: session.lastApiPromptTokenCount,
      });

      if (session.debugCostEnabled) {
        const reportLine = formatCostAuditReport(
          [rec],
          committedTurnCostUsd,
          session.costRecords.reduce<number | null>((acc, r) => {
            if (r.costUsd === null) return null;
            return (acc ?? 0) + r.costUsd;
          }, 0),
          modelId,
          session.settings.modelPricing,
        );
        options.onSystemNotice?.(reportLine.slice(1, -1).join('\n'));
      }
    };

    const closeCurrentThinkingBlock = async (
      titulo: string,
      useApiSummarizer = true,
    ) => {
      const snapshot = {
        subthinkings: [...blockAcc.subthinkings],
        commands: [...blockAcc.commands],
        toolRoundsInBlock: blockAcc.toolRoundsInBlock,
      };
      resetThinkingBlockAccumulator(blockAcc);
      if (!useApiSummarizer) {
        const detSummary = buildDeterministicBlockSummary(titulo, snapshot);
        options.onBlockSummary?.({
          title: titulo,
          summary: detSummary,
          usedFallback: true,
          commandsCount: snapshot.commands.length,
        });
        return;
      }
      const sumRes = await summarizeThinkingBlock({
        titulo,
        acc: snapshot,
        adapter: getAdapter(),
        summaryModel:
          session.settings.thinkingSummaryModel ?? 'gemini-3.1-pro-preview',
        abortSignal,
      });
      if (sumRes.usage) {
        commitRequestUsageRecord(
          sumRes.usage,
          sumRes.modelId,
          'thinking_summary',
        );
      }
      options.onBlockSummary?.({
        title: titulo,
        summary: sumRes.summaryText,
        usedFallback: sumRes.usedFallback,
        commandsCount: snapshot.commands.length,
      });
    };

    let keepGoing = true;
    while (keepGoing) {
      if (abortSignal?.aborted) {
        ensureHistoryFunctionCallsResolved(session.history);
        return {
          finalText: finalAccText,
          finalThought: finalAccThought,
          durationText: formatElapsedDuration(Date.now() - startTs),
          aborted: true,
          committedTurnCostUsd,
        };
      }

      currentStepAbortController = new AbortController();
      const stepSignal = currentStepAbortController.signal;

      // Al inicio del paso, inyectar correcciones prioritarias del usuario o reportes de subagentes ya terminados
      const completedSubReports = drainCompletedUnconsumedSubagents(
        turnSubagentHandles,
      );
      if (completedSubReports.length > 0) {
        const formattedReports = completedSubReports
          .map((r) => formatSubagentOutcomeForModel(r))
          .join(`${os.EOL}${os.EOL}`);
        injectUserTextIntoHistory(
          session.history,
          `[Resultados de subagentes finalizados]${os.EOL}${formattedReports}`,
        );
      }
      if (pendingPriorityMessages.length > 0) {
        const prioText = pendingPriorityMessages.splice(0).join(os.EOL);
        injectUserTextIntoHistory(session.history, prioText);
      }

      const activeAdapter = getAdapter();
      const preTurnLive = session.getLiveCallConfig((warnMsg) => {
        options.onSystemNotice?.(warnMsg);
        options.onSettingsReconciled?.();
      });
      const activeSkillsArr = Array.from(activeSkillContents.values());

      const compactionOutcome = await maybeAutoCompactContext({
        history: session.history,
        settings: session.settings,
        adapter: activeAdapter,
        currentUserPrompt: userPrompt,
        availableSkills: installedSkills,
        activeSkillContents: activeSkillsArr,
        mcpServers,
        apiReportedPromptTokens: session.lastApiPromptTokenCount,
        tracker: compactionTracker,
        maxTokens: maxContextTokens,
        abortSignal,
        onCompactingStatusChange: options.onCompactingStatusChange,
        onSubAgentUsage: (liveSubUsage) => {
          const curLive = session.getLiveCallConfig();
          const subPreviewCost = calculateApiUsageCostUsd(
            liveSubUsage,
            curLive.model,
            session.settings.modelPricing,
            true,
          );
          const liveCost =
            subPreviewCost === null || turnHasUnknownCost
              ? null
              : (committedTurnCostUsd ?? 0) + subPreviewCost;
          options.onUsage?.({
            phase: 'in_flight',
            modelId: curLive.model,
            usage: liveSubUsage,
            committedTurnCostUsd,
            liveTurnCostUsd: liveCost,
            turnHasUnknownCost,
            lastApiPromptTokens: session.lastApiPromptTokenCount,
          });
        },
      });

      if (abortSignal?.aborted) {
        ensureHistoryFunctionCallsResolved(session.history);
        return {
          finalText: finalAccText,
          finalThought: finalAccThought,
          durationText: formatElapsedDuration(Date.now() - startTs),
          aborted: true,
          committedTurnCostUsd,
        };
      }

      options.onCompactionResult?.(compactionOutcome);

      if (compactionOutcome.compacted && compactionOutcome.usedTokensAfter) {
        session.lastApiPromptTokenCount = compactionOutcome.usedTokensAfter;
      }

      if (compactionOutcome.subAgentUsage) {
        commitRequestUsageRecord(
          compactionOutcome.subAgentUsage,
          preTurnLive.model,
          'compaction',
        );
      }

      if (compactionOutcome.chatDisplayBlock) {
        options.onSystemNotice?.(compactionOutcome.chatDisplayBlock);
        options.onPersistCheckpoint?.();
      }
      if (compactionOutcome.warningMessage) {
        options.onSystemNotice?.(compactionOutcome.warningMessage);
      }

      const buildLiveRequestOptions = (): ProviderRequestOptions => {
        const currentLive = session.getLiveCallConfig((warnMsg) => {
          options.onSystemNotice?.(warnMsg);
          options.onSettingsReconciled?.();
        });
        const currentSkillContents = Array.from(activeSkillContents.values());
        return {
          model: currentLive.model,
          effort: currentLive.effort,
          includeThoughts: currentLive.includeThoughts,
          subMode: currentLive.subMode,
          permissionMode: currentLive.permissionMode,
          abortSignal: stepSignal,
          enableTools: true,
          systemInstruction: buildGlitchSystemInstruction(
            currentLive.subMode,
            currentSkillContents,
            installedSkills,
            currentLive.allowAgentQuestions,
          ),
          getLiveOptions: buildLiveRequestOptions,
        };
      };

      const collectedParts: Part[] = [];
      let accText = '';
      let accThought = '';
      let attemptUsage: ApiTokenUsage = { ...EMPTY_API_TOKEN_USAGE };
      let sawAttemptUsage = false;
      let live = session.getLiveCallConfig();

      await withRetry(
        async () => {
          collectedParts.length = 0;
          accText = '';
          accThought = '';
          attemptUsage = { ...EMPTY_API_TOKEN_USAGE };
          sawAttemptUsage = false;
          const requestAdapter = getAdapter();
          const requestOptions = buildLiveRequestOptions();
          live = session.getLiveCallConfig();
          options.onCallConfigBuilt?.(requestOptions);
          recordApiRequestDebugLog({
            provider: requestAdapter.id,
            model: requestOptions.model,
            effort: requestOptions.effort,
            thinkingParameter: `effort=${requestOptions.effort}`,
            subMode: requestOptions.subMode,
            includeThoughts: requestOptions.includeThoughts,
          });

          for await (const chunk of requestAdapter.streamTurn(
            session.history,
            requestOptions,
          )) {
            if (chunk.usage) {
              sawAttemptUsage = true;
              attemptUsage = mergeStreamChunkUsage(attemptUsage, chunk.usage);
              const liveCtxTokens = computeLastRequestContextTokens(attemptUsage);
              if (liveCtxTokens && liveCtxTokens > 0) {
                session.lastApiPromptTokenCount = liveCtxTokens;
              }
              const liveAttemptCost = calculateApiUsageCostUsd(
                attemptUsage,
                live.model,
                session.settings.modelPricing,
                true,
                {
                  referenceDate: options.referenceDate,
                  regionalSurchargePct: session.settings.regionalSurchargePct,
                },
              );
              const liveTurnCost =
                liveAttemptCost === null || turnHasUnknownCost
                  ? null
                  : (committedTurnCostUsd ?? 0) + liveAttemptCost;
              options.onUsage?.({
                phase: 'in_flight',
                modelId: live.model,
                usage: { ...attemptUsage },
                committedTurnCostUsd,
                liveTurnCostUsd: liveTurnCost,
                turnHasUnknownCost,
                lastApiPromptTokens: session.lastApiPromptTokenCount,
              });
            }
            if (abortSignal?.aborted || stepSignal.aborted) {
              break;
            }
            if (chunk.rawParts && chunk.rawParts.length > 0) {
              collectedParts.push(...chunk.rawParts);
            }
            if (chunk.thoughtText && live.includeThoughts) {
              accThought += chunk.thoughtText;
              options.onThought?.(chunk.thoughtText, accThought);
            }
            if (chunk.text) {
              accText += chunk.text;
              options.onText?.(chunk.text, accText);
            }
          }
        },
        {
          maxRetries: maxStreamRetries,
          baseDelayMs,
          abortSignal: stepSignal,
          onRetry: (attempt, delayMs, err) => {
            if (sawAttemptUsage && hasAnyApiTokenUsage(attemptUsage)) {
              commitRequestUsageRecord(attemptUsage, live.model, 'retry');
              attemptUsage = { ...EMPTY_API_TOKEN_USAGE };
              sawAttemptUsage = false;
            }
            retryOptions?.onRetry?.(attempt, delayMs, err);
            const retryBanner = `Reconectando tras fallo de red (intento ${attempt}/${maxStreamRetries})...`;
            options.onSystemNotice?.(retryBanner);
          },
        },
      );

      if (sawAttemptUsage) {
        commitRequestUsageRecord(
          attemptUsage,
          live.model,
          stepInTurnIdx === 0 ? 'agent' : 'tool_followup',
        );
      }
      stepInTurnIdx++;

      finalAccText = accText;
      finalAccThought = accThought;
      elapsed = formatElapsedDuration(Date.now() - startTs);

      if (abortSignal?.aborted) {
        const cancelNote = '[Cancelado con ESC]';
        const finalText = accText ? `${accText} ${cancelNote}` : cancelNote;
        session.history.push({
          role: 'model',
          parts: [{ text: finalText }],
        });
        options.onStepMessage?.({
          text: finalText,
          thoughtText: accThought || undefined,
          durationText: elapsed,
          isFinal: true,
          isCancelled: true,
        });
        options.onPersistCheckpoint?.();
        return {
          finalText,
          finalThought: accThought,
          durationText: elapsed,
          aborted: true,
          committedTurnCostUsd,
        };
      }

      // Si el paso del principal fue interrumpido por una corrección del usuario a un subagente (sin ESC), retomamos el bucle con la corrección
      if (stepSignal.aborted && !abortSignal?.aborted) {
        if (accText.trim()) {
          session.history.push({
            role: 'model',
            parts: [{ text: accText.trim() }],
          });
        }
        continue;
      }

      const functionCallParts = collectedParts.filter((p) =>
        Boolean(p.functionCall?.name),
      );

      if (functionCallParts.length === 0) {
        session.history.push({
          role: 'model',
          parts:
            collectedParts.length > 0
              ? collectedParts
              : [{ text: finalAccText }],
        });

        // Si el principal no llamó a esperar_subagentes pero hay subagentes de este turno aún corriendo o con resultados pendientes, esperarlos e inyectar sus resultados en el siguiente paso
        const hasUnconsumedSubagents = turnSubagentHandles.some(
          (h) => !h.consumedByParent,
        );
        if (hasUnconsumedSubagents && !abortSignal?.aborted) {
          if (finalAccText.trim() || finalAccThought.trim()) {
            options.onStepMessage?.({
              text: finalAccText,
              thoughtText: finalAccThought || undefined,
              durationText: elapsed,
              isFinal: false,
            });
          }
          const waitOutcome = await waitForSubagents(undefined, {
            abortSignal,
            interruptSignal: stepSignal,
            handles: turnSubagentHandles,
          });
          if (waitOutcome.abortedByEsc || abortSignal?.aborted) {
            return {
              finalText: finalAccText,
              finalThought: finalAccThought,
              durationText: formatElapsedDuration(Date.now() - startTs),
              aborted: true,
              committedTurnCostUsd,
            };
          }
          if (waitOutcome.results.length > 0) {
            const formattedAll = waitOutcome.results
              .map((r) => formatSubagentOutcomeForModel(r))
              .join(`${os.EOL}${os.EOL}`);
            injectUserTextIntoHistory(
              session.history,
              `[Resultados de subagentes finalizados]${os.EOL}${formattedAll}`,
            );
          }
          continue;
        }

        if (hasThinkingBlockContent(blockAcc) && !abortSignal?.aborted) {
          await closeCurrentThinkingBlock('resumen del bloque', false);
        }

        if (finalAccText.trim().length > 0 || finalAccThought.trim().length > 0) {
          options.onStepMessage?.({
            text: finalAccText,
            thoughtText: finalAccThought || undefined,
            durationText: elapsed,
            isFinal: true,
          });
        }
        options.onPersistCheckpoint?.();

        if (shouldContinueTask) {
          keepGoing = await shouldContinueTask(
            stepInTurnIdx,
            finalAccText,
            session,
          );
        } else {
          keepGoing = false;
        }
        continue;
      }

      session.history.push({
        role: 'model',
        parts: collectedParts,
      });

      const hasVisibleToolCalls = functionCallParts.some(
        (p) => p.functionCall?.name && p.functionCall.name !== 'cerrar_bloque',
      );

      const hasInlineThoughtParts = collectedParts.some((p) => {
        const rec = p as Record<string, unknown>;
        const pType =
          typeof rec['type'] === 'string' ? rec['type'].toLowerCase() : '';
        return (
          Boolean(rec['thought']) ||
          pType === 'thinking' ||
          pType === 'reasoning' ||
          typeof rec['thinking'] === 'string' ||
          typeof rec['reasoning'] === 'string'
        );
      });

      if (!hasInlineThoughtParts) {
        const stepVisibleText = hasVisibleToolCalls ? '' : accText.trim();
        const stepThought = accThought.trim() || undefined;
        if (stepThought || stepVisibleText) {
          options.onStepMessage?.({
            text: stepVisibleText,
            thoughtText: stepThought,
            durationText: elapsed,
            isFinal: false,
          });
        }
      }

      let pendingInlineThought = '';
      let pendingInlineText = '';

      const flushPendingThoughtAndText = (suppressTextForTool = false) => {
        const textToEmit = suppressTextForTool ? '' : pendingInlineText.trim();
        const thoughtToEmit = pendingInlineThought.trim() || undefined;
        if (thoughtToEmit || textToEmit) {
          options.onStepMessage?.({
            text: textToEmit,
            thoughtText: thoughtToEmit,
            durationText: elapsed,
            isFinal: false,
          });
        }
        pendingInlineThought = '';
        if (!suppressTextForTool) {
          pendingInlineText = '';
        }
      };

      const stepSubthinking = accText.trim() || undefined;
      let unconsumedStepSubthinking = stepSubthinking;
      if (stepSubthinking) {
        recordBlockSubthinking(blockAcc, stepSubthinking);
      }

      for (const part of collectedParts) {
        const partRec = part as Record<string, unknown>;
        const partType =
          typeof partRec['type'] === 'string'
            ? partRec['type'].toLowerCase()
            : '';
        const isThoughtPart =
          Boolean(partRec['thought']) ||
          partType === 'thinking' ||
          partType === 'reasoning' ||
          typeof partRec['thinking'] === 'string' ||
          typeof partRec['reasoning'] === 'string';

        if (isThoughtPart) {
          const tText =
            part.text ??
            (typeof partRec['thinking'] === 'string'
              ? partRec['thinking']
              : typeof partRec['reasoning'] === 'string'
                ? partRec['reasoning']
                : '');
          if (tText) {
            pendingInlineThought += tText;
          }
          continue;
        }

        if (!part.functionCall?.name && part.text) {
          pendingInlineText += part.text;
          recordBlockSubthinking(blockAcc, part.text);
          continue;
        }

        if (!part.functionCall?.name) {
          continue;
        }

        const fc = part.functionCall!;
        const name = fc.name ?? '';
        if (name === 'cerrar_bloque') {
          continue;
        }

        if (hasInlineThoughtParts && pendingInlineThought.trim()) {
          flushPendingThoughtAndText(true);
        }

        const inlineSub =
          pendingInlineText.trim() || unconsumedStepSubthinking;
        pendingInlineText = '';
        unconsumedStepSubthinking = undefined;

        const args = (fc.args ?? {}) as Record<string, unknown>;
        const summary = formatToolActionSummary(name, args);
        options.onToolStart?.({
          id: fc.id,
          name,
          args,
          summary,
          subthinking: inlineSub,
        });
      }

      if (hasInlineThoughtParts) {
        flushPendingThoughtAndText(hasVisibleToolCalls);
      } else if (!hasVisibleToolCalls && pendingInlineText.trim()) {
        pendingInlineText = '';
      }

      let closedBlockInThisRound = false;

      const executeSingleToolPart = async (part: Part): Promise<Part> => {
        const toolStartMs = Date.now();
        const fc = part.functionCall!;
        const name = fc.name ?? '';
        const args = (fc.args ?? {}) as Record<string, unknown>;

        if (abortSignal?.aborted) {
          return {
            functionResponse: {
              id: fc.id,
              name,
              response: { error: 'cancelado por el usuario' },
            },
          };
        }

        if (name === 'cerrar_bloque') {
          closedBlockInThisRound = true;
          const titulo =
            typeof args['titulo'] === 'string' && args['titulo'].trim()
              ? args['titulo'].trim()
              : 'bloque completado';
          await closeCurrentThinkingBlock(titulo);
          return {
            functionResponse: {
              id: fc.id,
              name: 'cerrar_bloque',
              response: { result: 'bloque cerrado' },
            },
          };
        }

        if (stepSignal.aborted) {
          return {
            functionResponse: {
              id: fc.id,
              name,
              response: { result: 'interrumpido por corrección del usuario' },
            },
          };
        }

        const liveToolCfg = session.getLiveCallConfig((warnMsg) => {
          options.onSystemNotice?.(warnMsg);
          options.onSettingsReconciled?.();
        });

        if (
          name === 'ask_user' &&
          liveToolCfg.allowAgentQuestions &&
          options.onAskUser
        ) {
          const question = String(args['question'] ?? '').trim();
          const header =
            typeof args['header'] === 'string' ? args['header'] : undefined;
          const optsList = Array.isArray(args['options'])
            ? (args['options'] as unknown[]).map((o) => String(o))
            : [];
          const raced = await raceWithSignals(
            options.onAskUser({
              question,
              header,
              options: optsList,
            }),
            abortSignal,
            stepSignal,
          );
          if (raced.kind === 'aborted') {
            options.onCancelAskUser?.();
            return {
              functionResponse: {
                id: fc.id,
                name,
                response: { error: 'cancelado por el usuario' },
              },
            };
          }
          if (raced.kind === 'step_interrupted') {
            options.onCancelAskUser?.();
            return {
              functionResponse: {
                id: fc.id,
                name,
                response: { result: 'interrumpido por corrección del usuario' },
              },
            };
          }
          const userAnswer = raced.value;
          options.onSystemNotice?.(
            `Respuesta enviada a ask_user: ${userAnswer}`,
          );
          options.onToolResult?.({
            id: fc.id,
            name,
            args,
            result: userAnswer,
            durationMs: Date.now() - toolStartMs,
          });
          options.onPersistCheckpoint?.();
          return {
            functionResponse: {
              id: fc.id,
              name,
              response: { result: userAnswer },
            },
          };
        }

        if (name === 'spawn_subagent') {
          const round = nextSubagentRound();
          const handle = startSubagentInBackground(
            {
              name:
                typeof args['name'] === 'string' ? args['name'] : undefined,
              task: String(args['task'] ?? ''),
              sub_mode:
                typeof args['sub_mode'] === 'string'
                  ? args['sub_mode']
                  : undefined,
              round,
            },
            {
              getAdapter,
              model: liveToolCfg.model,
              effort: liveToolCfg.effort,
              includeThoughts: liveToolCfg.includeThoughts,
              parentSubMode: liveToolCfg.subMode,
              permissionMode: liveToolCfg.permissionMode,
              availableSkills: installedSkills,
              initialActiveSkills: activeSkillContents,
              thinkingSummaryModel: session.settings.thinkingSummaryModel,
              subagentMaxSteps: session.settings.subagentMaxSteps ?? 0,
              round,
              originChatTitle: deriveSessionTitle(
                [],
                session.history,
                session.customTitle,
              ),
              onSubagentUpdate: options.onSubagentUpdate,
              onSubagentLog: (logMsg) => {
                options.onSubagentLog?.(logMsg);
              },
              onSubAgentUsage: (subUsage, subModel, subKind) => {
                commitRequestUsageRecord(
                  subUsage,
                  subModel,
                  subKind ?? 'tool_followup',
                );
              },
            },
          );
          turnSubagentHandles.push(handle);
          const launchedText = `lanzado: ${handle.id}`;
          options.onToolResult?.({
            id: fc.id,
            name,
            args,
            result: launchedText,
            durationMs: Date.now() - toolStartMs,
          });
          options.onPersistCheckpoint?.();
          return {
            functionResponse: {
              id: fc.id,
              name,
              response: { result: launchedText },
            },
          };
        }

        if (name === 'spawn_parallel_subagents') {
          const round = nextSubagentRound();
          const rawAgents = Array.isArray(args['agents'])
            ? (args['agents'] as Array<Record<string, unknown>>)
            : [];
          const inputs: SubagentTaskInput[] = rawAgents.map((a, idx) => ({
            name:
              typeof a['name'] === 'string' && a['name'].trim()
                ? a['name'].trim()
                : `Agente ${idx + 1}`,
            task: String(a['task'] ?? ''),
            sub_mode:
              typeof a['sub_mode'] === 'string' ? a['sub_mode'] : undefined,
            round,
          }));

          const handles = inputs.map((inp) =>
            startSubagentInBackground(inp, {
              getAdapter,
              model: liveToolCfg.model,
              effort: liveToolCfg.effort,
              includeThoughts: liveToolCfg.includeThoughts,
              parentSubMode: liveToolCfg.subMode,
              permissionMode: liveToolCfg.permissionMode,
              availableSkills: installedSkills,
              initialActiveSkills: activeSkillContents,
              thinkingSummaryModel: session.settings.thinkingSummaryModel,
              subagentMaxSteps: session.settings.subagentMaxSteps ?? 0,
              round,
              originChatTitle: deriveSessionTitle(
                [],
                session.history,
                session.customTitle,
              ),
              onSubagentUpdate: options.onSubagentUpdate,
              onSubagentLog: (logMsg) => {
                options.onSubagentLog?.(logMsg);
              },
              onSubAgentUsage: (subUsage, subModel, subKind) => {
                commitRequestUsageRecord(
                  subUsage,
                  subModel,
                  subKind ?? 'tool_followup',
                );
              },
            }),
          );
          turnSubagentHandles.push(...handles);
          const launchedText = `lanzado: ${handles.map((h) => h.id).join(', ')}`;
          options.onToolResult?.({
            id: fc.id,
            name,
            args,
            result: launchedText,
            durationMs: Date.now() - toolStartMs,
          });
          options.onPersistCheckpoint?.();
          return {
            functionResponse: {
              id: fc.id,
              name,
              response: { result: launchedText },
            },
          };
        }

        if (name === 'esperar_subagentes') {
          const rawIds = Array.isArray(args['ids'])
            ? (args['ids'] as unknown[]).map((x) => String(x))
            : undefined;
          const waitRes = await waitForSubagents(rawIds, {
            abortSignal,
            interruptSignal: stepSignal,
            handles: turnSubagentHandles,
          });
          if (waitRes.abortedByEsc || abortSignal?.aborted) {
            return {
              functionResponse: {
                id: fc.id,
                name,
                response: { error: 'cancelado por el usuario' },
              },
            };
          }
          if (waitRes.interruptedByUserCorrection) {
            const interruptedMsg = 'interrumpido por corrección del usuario';
            options.onToolResult?.({
              id: fc.id,
              name,
              args,
              result: interruptedMsg,
              durationMs: Date.now() - toolStartMs,
            });
            return {
              functionResponse: {
                id: fc.id,
                name,
                response: { result: interruptedMsg },
              },
            };
          }
          const formattedAll = waitRes.results
            .map((r) => formatSubagentOutcomeForModel(r))
            .join(`${os.EOL}${os.EOL}`);
          options.onToolResult?.({
            id: fc.id,
            name,
            args,
            result: formattedAll,
            durationMs: Date.now() - toolStartMs,
          });
          options.onPersistCheckpoint?.();
          return {
            functionResponse: {
              id: fc.id,
              name,
              response: { result: formattedAll },
            },
          };
        }

        const outcome = await executeGlitchToolCallAsync(
          name,
          args,
          liveToolCfg.permissionMode,
          liveToolCfg.subMode,
          installedSkills,
          (activatedSkill) => {
            activeSkillContents.set(
              activatedSkill.name,
              activatedSkill.content,
            );
            options.onSkillActivated?.(
              activatedSkill,
              Array.from(activeSkillContents.keys()),
            );
            options.onSystemNotice?.(
              `Skill activada en sesión: ${activatedSkill.name} (${activatedSkill.sourceLabel})`,
            );
          },
          liveToolCfg.allowAgentQuestions,
          stepSignal,
        );

        if (abortSignal?.aborted) {
          return {
            functionResponse: {
              id: fc.id,
              name,
              response: { error: 'cancelado por el usuario' },
            },
          };
        }

          recordBlockToolExecution(blockAcc, {
            name,
            summary: formatToolActionSummary(name, args),
            result: outcome.result,
            error: outcome.error,
            ok: !outcome.error,
          });

          if (outcome.error) {
            options.onSystemNotice?.(`  error ${name}: ${outcome.error}`);
          }

          options.onToolResult?.({
            id: fc.id,
            name,
            args,
            result: outcome.result,
            error: outcome.error,
            durationMs: Date.now() - toolStartMs,
          });

          options.onPersistCheckpoint?.();

          return {
            functionResponse: {
              id: fc.id,
              name,
              response: outcome.error
                ? { error: outcome.error }
                : { result: outcome.result ?? '' },
            },
          };
        };

        const responseParts: Part[] = [];
        const hasInteractiveAskUser = functionCallParts.some(
          (p) => p.functionCall?.name === 'ask_user',
        );
        if (!hasInteractiveAskUser && functionCallParts.length > 1) {
          const parallelOutcomes = await Promise.all(
            functionCallParts.map((p) => executeSingleToolPart(p)),
          );
          responseParts.push(...parallelOutcomes);
        } else {
          for (const part of functionCallParts) {
            if (abortSignal?.aborted) {
              const fc = part.functionCall!;
              responseParts.push({
                functionResponse: {
                  id: fc.id,
                  name: fc.name ?? '',
                  response: { error: 'cancelado por el usuario' },
                },
              });
              continue;
            }
            responseParts.push(await executeSingleToolPart(part));
          }
        }

        if (!closedBlockInThisRound) {
          blockAcc.toolRoundsInBlock += 1;
          if (
            blockAcc.toolRoundsInBlock >= 6 &&
            hasThinkingBlockContent(blockAcc) &&
            !abortSignal?.aborted
          ) {
            await closeCurrentThinkingBlock('avance de herramientas');
          }
        }

      session.history.push({
        role: 'user',
        parts: responseParts,
      });
      options.onPersistCheckpoint?.();

      if (abortSignal?.aborted) {
        return {
          finalText: finalAccText,
          finalThought: finalAccThought,
          durationText: formatElapsedDuration(Date.now() - startTs),
          aborted: true,
          committedTurnCostUsd,
        };
      }
    }

    return {
      finalText: finalAccText,
      finalThought: finalAccThought,
      durationText: elapsed,
      aborted: false,
      committedTurnCostUsd,
    };
  } catch (err) {
    ensureHistoryFunctionCallsResolved(session.history);
    if (abortSignal?.aborted) {
      options.onSystemNotice?.('Petición cancelada por el usuario (ESC).');
      return {
        finalText: finalAccText,
        finalThought: finalAccThought,
        durationText: elapsed,
        aborted: true,
        committedTurnCostUsd,
      };
    }
    options.onSystemNotice?.(formatCleanApiError(err));
    return {
      finalText: finalAccText,
      finalThought: finalAccThought,
      durationText: elapsed,
      aborted: false,
      committedTurnCostUsd,
    };
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener('abort', onTurnAbort);
    }
    ensureHistoryFunctionCallsResolved(session.history);
    session.isRequestActive = false;
  }
}

export interface TurnRunnerHookOptions {
  shouldContinueTask?: (
    stepIndex: number,
    lastReplyText: string,
    session: SessionState,
  ) => Promise<boolean> | boolean;
  retryOptions?: RetryOptions;
  maxContextTokens?: number;
  onCompactingStatusChange?: (isCompacting: boolean) => void;
  onSubagentUpdate?: (info: LiveSubagentInfo) => void;
  onAskUser?: (args: {
    question: string;
    header?: string;
    options: string[];
  }) => Promise<string>;
  onText?: (deltaText: string, accumulatedText: string) => void;
  onThought?: (deltaThought: string, accumulatedThought: string) => void;
  onToolStart?: (ev: TurnToolStartEvent) => void;
  onToolResult?: (ev: TurnToolResultEvent) => void;
  onBlockSummary?: (ev: ThinkingBlockSummaryEvent) => void;
  onUsage?: (ev: TurnUsageEvent) => void;
}

export class TurnRunner {
  private readonly queue: string[] = [];
  private processingPromise: Promise<void> | null = null;
  public readonly recordedCallConfigs: ProviderRequestOptions[] = [];
  private readonly availableSkills: SkillInfo[];
  private readonly activeSkillContents = new Map<string, string>();
  private readonly compactionTracker = createCompactionTracker();
  private currentAbortController: AbortController | null = null;
  public readonly stepControllerRef: TurnStepControllerRef = {
    interruptCurrentStepForCorrection: () => {},
  };

  constructor(
    private readonly session: SessionState,
    private readonly getAdapter: () => ProviderAdapter,
    private readonly onStreamText: (text: string) => void = (text) =>
      process.stdout.write(text),
    private readonly onError: (msg: string) => void = (msg) =>
      console.error(msg),
    private readonly stepHook?: TurnRunnerHookOptions,
    availableSkills?: readonly SkillInfo[],
  ) {
    this.availableSkills = availableSkills
      ? [...availableSkills]
      : discoverInstalledSkills();
  }

  getQueuedPrompts(): readonly string[] {
    return this.queue;
  }

  updateQueuedPromptAt(index: number, newText: string): boolean {
    const trimmed = newText.trim();
    if (!trimmed || index < 0 || index >= this.queue.length) {
      return false;
    }
    this.queue[index] = trimmed;
    return true;
  }

  removeQueuedPromptAt(index: number): boolean {
    if (index < 0 || index >= this.queue.length) {
      return false;
    }
    this.queue.splice(index, 1);
    return true;
  }

  getQueueIndexFromStepsUp(stepsUp: number): number {
    if (stepsUp <= 0 || this.queue.length === 0) {
      return -1;
    }
    return Math.max(0, this.queue.length - stepsUp);
  }

  abortCurrentTurn(): number {
    const dropped = this.queue.length;
    this.queue.length = 0;
    if (dropped > 0) {
      this.onStreamText(`\nse descartaron ${dropped} mensajes en fila\n`);
    }
    this.currentAbortController?.abort();
    abortAllRunningSubagents();
    killAllActiveShellCommands();
    this.session.isRequestActive = false;
    return dropped;
  }

  enqueuePrompt(userText: string): Promise<void> {
    const trimmed = userText.trim();
    if (!trimmed || trimmed.startsWith('/')) {
      return Promise.resolve();
    }
    this.queue.push(trimmed);
    if (!this.processingPromise) {
      this.processingPromise = this.drainQueue().finally(() => {
        this.processingPromise = null;
        this.session.isRequestActive = false;
      });
    }
    return this.processingPromise;
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const prompt = this.queue.shift()!;
      const ac = new AbortController();
      this.currentAbortController = ac;
      try {
        await runSingleTurn({
          session: this.session,
          userPrompt: prompt,
          getAdapter: this.getAdapter,
          abortSignal: ac.signal,
          stepControllerRef: this.stepControllerRef,
          installedSkills: this.availableSkills,
          activeSkillContents: this.activeSkillContents,
          compactionTracker: this.compactionTracker,
          maxContextTokens: this.stepHook?.maxContextTokens,
          retryOptions: this.stepHook?.retryOptions,
          shouldContinueTask: this.stepHook?.shouldContinueTask,
          onCompactingStatusChange: this.stepHook?.onCompactingStatusChange,
          onSubagentUpdate: this.stepHook?.onSubagentUpdate,
          onAskUser: this.stepHook?.onAskUser,
          onCallConfigBuilt: (cfg) => this.recordedCallConfigs.push(cfg),
          onText: (delta, acc) => {
            this.onStreamText(delta);
            this.stepHook?.onText?.(delta, acc);
          },
          onThought: (delta, acc) => {
            this.stepHook?.onThought?.(delta, acc);
          },
          onStepMessage: (msg) => {
            if (msg.thoughtText) {
              this.onStreamText(`\nPensando...\n${msg.thoughtText}\n`);
            }
          },
          onToolStart: (ev) => {
            this.onStreamText(`\n${ev.summary}\n`);
            this.stepHook?.onToolStart?.(ev);
          },
          onToolResult: (ev) => {
            this.stepHook?.onToolResult?.(ev);
          },
          onBlockSummary: (ev) => {
            this.onStreamText(`\n[${ev.title}] ${ev.summary}\n`);
            this.stepHook?.onBlockSummary?.(ev);
          },
          onSubagentLog: (logMsg) => {
            this.onStreamText(`\n${logMsg}\n`);
          },
          onUsage: (ev) => {
            this.stepHook?.onUsage?.(ev);
          },
          onSystemNotice: (notice) => {
            if (notice.startsWith('Reconectando')) {
              this.onStreamText(`\n${notice}\n`);
            } else if (notice.startsWith('Error')) {
              this.onError(notice);
            } else {
              this.onStreamText(`\n${notice}\n`);
            }
          },
        });
      } finally {
        this.currentAbortController = null;
        this.session.isRequestActive = false;
      }
      if (ac.signal.aborted) {
        break;
      }
    }
  }
}
