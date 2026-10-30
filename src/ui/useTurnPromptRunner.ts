import { formatMessageTimestamp } from '../core/errorFormat.js';
import type { CompactionTracker } from '../core/compaction.js';
import type { InputUndoManager } from '../core/lineEditor.js';
import type { McpServerEntry } from '../core/mcpRegistry.js';
import type { SessionState } from '../core/session.js';
import {
  generateSessionSummaryTitle,
  isBareGreetingMessage,
  type SavedUiMessage,
} from '../core/sessionStore.js';
import type { SkillInfo } from '../core/skills.js';
import {
  abortAllRunningSubagents,
  relaunchSubagentWithCorrection,
  sendSubagentCorrection,
  type LiveSubagentInfo,
} from '../core/subagents.js';
import {
  formatCompactToolCallLine,
  killAllActiveShellCommands,
} from '../core/tools.js';
import {
  runSingleTurn,
  type TurnStepControllerRef,
} from '../core/turnRunner.js';
import type { GlitchSettings } from '../config/settings.js';
import { CustomProviderAdapter } from '../providers/custom.js';
import type { ApiTokenUsage, ProviderAdapter } from '../providers/types.js';
import {
  VertexProviderAdapter,
  createVertexGenAI,
} from '../providers/vertex.js';
import type { ActiveDialog, PendingAskUserPrompt } from './DialogsView.js';
import type { CostRequestRecord } from './statusBar.js';
import { notifyUserForQuestion } from './tuiScrollMouse.js';

export interface TurnPromptRunnerDeps {
  sessionRef: React.MutableRefObject<SessionState>;
  streamStartTimeRef: React.MutableRefObject<number>;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
  messagesRef: React.MutableRefObject<SavedUiMessage[]>;
  activeSkillContentsRef: React.MutableRefObject<Map<string, string>>;
  compactionTrackerRef: React.MutableRefObject<CompactionTracker>;
  askUserUndoManagerRef: React.MutableRefObject<InputUndoManager>;
  queueRef: React.MutableRefObject<string[]>;
  installedSkills: readonly SkillInfo[];
  mcpServers: readonly McpServerEntry[];
  setStreamingElapsedMs: React.Dispatch<React.SetStateAction<number>>;
  setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setLiveThought: React.Dispatch<React.SetStateAction<string>>;
  setLiveText: React.Dispatch<React.SetStateAction<string>>;
  setMessages: React.Dispatch<React.SetStateAction<SavedUiMessage[]>>;
  setIsCompactingContext: React.Dispatch<React.SetStateAction<boolean>>;
  setSettings: React.Dispatch<React.SetStateAction<GlitchSettings>>;
  addSystemMessage: (text: string) => void;
  setLastTurnDurationText: React.Dispatch<React.SetStateAction<string>>;
  persistCurrentSession: (
    nextMessages: SavedUiMessage[],
    currentId?: string,
    syncImmediate?: boolean,
  ) => void;
  upsertLiveSubagent: (info: LiveSubagentInfo) => void;
  setLiveSubagents: React.Dispatch<React.SetStateAction<LiveSubagentInfo[]>>;
  setActiveSkillNames: React.Dispatch<React.SetStateAction<string[]>>;
  setLastApiPromptTokens: React.Dispatch<React.SetStateAction<number | null>>;
  setCurrentTurnCostUsd: React.Dispatch<React.SetStateAction<number | null>>;
  setLiveInFlightModelId: React.Dispatch<
    React.SetStateAction<string | undefined>
  >;
  setLiveInFlightUsage: React.Dispatch<
    React.SetStateAction<ApiTokenUsage | undefined>
  >;
  setCostRecords: React.Dispatch<React.SetStateAction<CostRequestRecord[]>>;
  setLastTurnCostUsd: React.Dispatch<React.SetStateAction<number | null>>;
  setSessionCostUsd: React.Dispatch<React.SetStateAction<number | null>>;
  setAskUserCursor: React.Dispatch<React.SetStateAction<number>>;
  setAskUserCustomText: React.Dispatch<React.SetStateAction<string>>;
  setAskUserCustomCursor: React.Dispatch<React.SetStateAction<number>>;
  setAskUserTypingCustom: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingAskUser: React.Dispatch<
    React.SetStateAction<PendingAskUserPrompt | null>
  >;
  setActiveDialog: React.Dispatch<React.SetStateAction<ActiveDialog>>;
  setEditingQueueIdx: React.Dispatch<React.SetStateAction<number | null>>;
  syncQueueState: () => void;
}

export function createTurnPromptActions(deps: TurnPromptRunnerDeps): {
  startOrEnqueuePrompt: (userPrompt: string) => void;
  cancelCurrentTurnAndQueue: () => void;
  injectBtwNote: (noteText: string) => void;
  submitSubagentCorrection: (
    sub: LiveSubagentInfo,
    correctionText: string,
    relaunchIfFinished?: boolean,
  ) => { status: 'sent_live' | 'needs_relaunch_confirm' | 'relaunched' };
} {
  const stepControllerRef: TurnStepControllerRef = {
    interruptCurrentStepForCorrection: () => {},
    injectBtwThoughtNote: () => {},
  };
  const pendingIdleBtwNotes: string[] = [];
  const buildAdapter = (): ProviderAdapter => {
    const cur = deps.sessionRef.current.settings;
    const retryOpts = { maxRetries: 9, baseDelayMs: 600 };
    if (cur.provider === 'custom' && cur.custom) {
      return new CustomProviderAdapter(cur.custom, fetch, retryOpts);
    }
    if (cur.provider === 'vertex' && cur.vertex) {
      return new VertexProviderAdapter(
        createVertexGenAI(cur.vertex),
        retryOpts,
      );
    }
    throw new Error('Autenticación no configurada. Usa /auth primero.');
  };

  const closeAskUserDialog = () => {
    deps.askUserUndoManagerRef.current.clear();
    deps.setPendingAskUser(null);
    deps.setActiveDialog((prev) => (prev === 'ask_user' ? 'none' : prev));
  };

  const promptUserWithTuiDialog = (
    question: string,
    header?: string,
    options: string[] = [],
  ): Promise<string> => {
    notifyUserForQuestion(question, header);
    return new Promise<string>((resolve) => {
      deps.askUserUndoManagerRef.current.clear();
      deps.setAskUserCursor(0);
      deps.setAskUserCustomText('');
      deps.setAskUserCustomCursor(0);
      deps.setAskUserTypingCustom(options.length === 0);
      deps.setPendingAskUser({ question, header, options, resolve });
      deps.setActiveDialog('ask_user');
    });
  };

  const cancelCurrentTurnAndQueue = () => {
    const droppedCount = deps.queueRef.current.length;
    deps.queueRef.current.length = 0;
    deps.syncQueueState();
    deps.setEditingQueueIdx(null);
    if (droppedCount > 0) {
      deps.addSystemMessage(
        `se descartaron ${droppedCount} mensajes en fila`,
      );
    }
    closeAskUserDialog();
    deps.abortControllerRef.current?.abort();
    abortAllRunningSubagents();
    killAllActiveShellCommands();
    deps.setLiveSubagents((prev) =>
      prev.map((s) =>
        s.status === 'running'
          ? {
              ...s,
              status: 'cancelled',
              finishedAt: Date.now(),
              currentAction: 'Cancelado con ESC',
            }
          : s,
      ),
    );
    deps.sessionRef.current.isRequestActive = false;
    deps.setIsStreaming(false);
    deps.setIsCompactingContext(false);
    deps.setLiveThought('');
    deps.setLiveText('');
    deps.setLiveInFlightUsage(undefined);
    deps.setLiveInFlightModelId(undefined);
  };

  const runSinglePromptNow = async (userPrompt: string): Promise<boolean> => {
    const session = deps.sessionRef.current;
    deps.streamStartTimeRef.current = Date.now();
    deps.setStreamingElapsedMs(0);
    deps.setIsStreaming(true);
    deps.setLiveThought('');
    deps.setLiveText('');

    const abortController = new AbortController();
    deps.abortControllerRef.current = abortController;

    const userMsg: SavedUiMessage = {
      id: `${Date.now()}-${Math.random()}-u`,
      role: 'user',
      text: userPrompt,
      timestamp: formatMessageTimestamp(new Date()),
    };
    deps.setMessages((prev) => {
      const next = [...prev, userMsg];
      deps.messagesRef.current = next;
      return next;
    });

    let lastStreamUiFlushTs = 0;
    const effectiveUserPrompt =
      pendingIdleBtwNotes.length > 0
        ? `${userPrompt}\n\n[Notas /btw en cadena de pensamiento]:\n${pendingIdleBtwNotes.splice(0).map((n) => `- ${n}`).join('\n')}`
        : userPrompt;
    try {
      const turnRes = await runSingleTurn({
        session,
        userPrompt: effectiveUserPrompt,
        getAdapter: buildAdapter,
        abortSignal: abortController.signal,
        stepControllerRef,
        installedSkills: deps.installedSkills,
        activeSkillContents: deps.activeSkillContentsRef.current,
        mcpServers: deps.mcpServers,
        compactionTracker: deps.compactionTrackerRef.current,
        onCompactingStatusChange: (flag) => deps.setIsCompactingContext(flag),
        onSettingsReconciled: () => deps.setSettings({ ...session.settings }),
        onSystemNotice: (notice) => {
          deps.addSystemMessage(notice);
          if (notice.startsWith('Reconectando')) deps.setLiveText(notice);
        },
        onThought: (_delta, accThought) => {
          const nowMs = Date.now();
          if (nowMs - lastStreamUiFlushTs >= 45) {
            lastStreamUiFlushTs = nowMs;
            deps.setLiveThought(accThought);
          }
        },
        onText: (_delta, accText) => {
          const nowMs = Date.now();
          if (nowMs - lastStreamUiFlushTs >= 45) {
            lastStreamUiFlushTs = nowMs;
            deps.setLiveText(accText);
          }
        },
        onStepMessage: (step) => {
          deps.setLiveThought('');
          deps.setLiveText('');
          deps.setLastTurnDurationText(step.durationText);
          const stepMsg: SavedUiMessage = {
            id: `${Date.now()}-${Math.random()}-${step.isFinal ? 'm' : 'm-step'}`,
            role: 'model',
            text: step.text,
            thoughtText: step.thoughtText,
            durationText: step.durationText,
          };
          deps.setMessages((prev) => {
            const next = [...prev, stepMsg];
            deps.messagesRef.current = next;
            if (step.isFinal) deps.persistCurrentSession(next);
            return next;
          });
        },
        onToolStart: (ev) => {
          deps.setLiveThought('');
          deps.setLiveText('');
          const callKey = ev.id || `${ev.name}-${Date.now()}-${Math.random()}`;
          const lineText = formatCompactToolCallLine({
            name: ev.name,
            args: ev.args,
            status: 'en vivo',
          });
          deps.setMessages((prev) => {
            const next: SavedUiMessage[] = [
              ...prev,
              {
                id: `${Date.now()}-${Math.random()}-tool`,
                role: 'system',
                text: lineText,
                subthinking: ev.subthinking,
                toolCallId: callKey,
                toolName: ev.name,
                toolArgs: ev.args,
                toolStatus: 'en vivo',
              },
            ];
            deps.messagesRef.current = next;
            return next;
          });
        },
        onToolResult: (ev) => {
          const status: SavedUiMessage['toolStatus'] = ev.error
            ? ev.error.toLowerCase().includes('cancelado')
              ? 'cancelado'
              : 'error'
            : 'listo';
          const lineText = formatCompactToolCallLine({
            name: ev.name,
            args: ev.args,
            durationMs: ev.durationMs,
            status,
          });
          deps.setMessages((prev) => {
            const next = [...prev];
            let targetIdx = -1;
            for (let i = next.length - 1; i >= 0; i--) {
              const m = next[i]!;
              if (
                m.toolStatus === 'en vivo' &&
                ((ev.id && m.toolCallId === ev.id) || m.toolName === ev.name)
              ) {
                targetIdx = i;
                break;
              }
            }
            if (targetIdx !== -1) {
              next[targetIdx] = {
                ...next[targetIdx]!,
                text: lineText,
                toolDurationMs: ev.durationMs,
                toolStatus: status,
              };
            }
            deps.messagesRef.current = next;
            return next;
          });
        },
        onBlockSummary: (ev) => {
          deps.setMessages((prev) => {
            const next: SavedUiMessage[] = [
              ...prev,
              {
                id: `${Date.now()}-${Math.random()}-block`,
                role: 'system',
                text: ev.summary,
                blockTitle: ev.title,
                isBlockSummary: true,
              },
            ];
            deps.messagesRef.current = next;
            deps.persistCurrentSession(next);
            return next;
          });
        },
        onSubagentUpdate: deps.upsertLiveSubagent,
        onAskUser: ({ question, header, options: opts }) =>
          promptUserWithTuiDialog(question, header, opts),
        onCancelAskUser: closeAskUserDialog,
        onSkillActivated: (_skill, names) => deps.setActiveSkillNames(names),
        onPersistCheckpoint: () =>
          deps.persistCurrentSession(deps.messagesRef.current),
        onUsage: (ev) => {
          if (ev.lastApiPromptTokens !== null && ev.lastApiPromptTokens > 0) {
            deps.setLastApiPromptTokens(ev.lastApiPromptTokens);
          }
          if (ev.phase === 'unknown_model_pricing') {
            deps.setCurrentTurnCostUsd(null);
          } else if (ev.phase === 'in_flight') {
            deps.setLiveInFlightModelId(ev.modelId);
            deps.setLiveInFlightUsage(ev.usage);
            deps.setCurrentTurnCostUsd(ev.liveTurnCostUsd);
          } else if (ev.phase === 'committed') {
            deps.setLiveInFlightUsage(undefined);
            deps.setLiveInFlightModelId(undefined);
            deps.setCostRecords([...session.costRecords]);
            deps.setCurrentTurnCostUsd(ev.committedTurnCostUsd);
            deps.setLastTurnCostUsd(ev.committedTurnCostUsd);
            deps.setSessionCostUsd(session.sessionCostUsd);
          }
        },
      });
      const wasAborted = turnRes.aborted || abortController.signal.aborted;
      if (!wasAborted && turnRes.finalText.trim().length > 0) {
        session.completedTurnsCount += 1;
        deps.persistCurrentSession(deps.messagesRef.current);
        const completedCount = session.completedTurnsCount;
        const firstUserMsg =
          deps.messagesRef.current.find((m) => m.role === 'user')?.text ?? '';
        const shouldGenerateAtFirst =
          completedCount === 1 && !isBareGreetingMessage(firstUserMsg);
        const shouldGenerateAtFifth = completedCount === 5;
        if (
          (shouldGenerateAtFirst || shouldGenerateAtFifth) &&
          session.titleGeneratedAtTurn < completedCount
        ) {
          const targetSession = session;
          session.titleGeneratedAtTurn = completedCount;
          void generateSessionSummaryTitle({
            messages: [...deps.messagesRef.current],
            history: [...session.history],
            adapter: buildAdapter(),
            summaryModel: session.settings.thinkingSummaryModel,
          }).then((generatedTitle) => {
            if (
              generatedTitle &&
              deps.sessionRef.current === targetSession &&
              targetSession.history.length > 0
            ) {
              targetSession.customTitle = generatedTitle;
              deps.persistCurrentSession(
                deps.messagesRef.current,
                undefined,
                true,
              );
            }
          });
        }
      }
      return wasAborted;
    } finally {
      deps.sessionRef.current.isRequestActive = false;
      deps.setLiveInFlightUsage(undefined);
      deps.setLiveInFlightModelId(undefined);
      deps.abortControllerRef.current = null;
    }
  };

  const startOrEnqueuePrompt = (userPrompt: string) => {
    const session = deps.sessionRef.current;
    if (session.isRequestActive) {
      deps.queueRef.current.push(userPrompt);
      deps.syncQueueState();
      return;
    }
    void (async () => {
      try {
        const wasAborted = await runSinglePromptNow(userPrompt);
        if (wasAborted) {
          deps.queueRef.current.length = 0;
          deps.syncQueueState();
          return;
        }
        while (deps.queueRef.current.length > 0) {
          const nextPrompt = deps.queueRef.current.shift()!;
          deps.setEditingQueueIdx((currIdx) =>
            currIdx === null ? null : currIdx > 0 ? currIdx - 1 : null,
          );
          deps.syncQueueState();
          const nextAborted = await runSinglePromptNow(nextPrompt);
          if (nextAborted) {
            deps.queueRef.current.length = 0;
            deps.syncQueueState();
            break;
          }
        }
      } finally {
        session.isRequestActive = false;
        deps.setIsStreaming(false);
        deps.setIsCompactingContext(false);
        deps.setLiveThought('');
        deps.setLiveText('');
      }
    })();
  };

  const submitSubagentCorrection = (
    sub: LiveSubagentInfo,
    correctionText: string,
    relaunchIfFinished = false,
  ): { status: 'sent_live' | 'needs_relaunch_confirm' | 'relaunched' } => {
    const clean = correctionText.trim();
    const isAmbiguous =
      clean.length < 12 && /\b(eso|esto|aquello|cámbialo|cambialo|arréglalo|arreglalo)\b/i.test(clean);

    if (sub.status !== 'running') {
      if (!relaunchIfFinished) {
        return { status: 'needs_relaunch_confirm' };
      }
      const relaunched = relaunchSubagentWithCorrection(sub.id, clean);
      if (relaunched) {
        deps.upsertLiveSubagent(relaunched.info);
        const resumeMsg = `[CORRECCIÓN PRIORITARIA DEL USUARIO]: Se relanzó el subagente "${sub.name}" (${relaunched.id}, Ronda ${relaunched.round}) con la corrección: "${clean}". Asume este contexto prioritario sin pedir confirmación y espera a que termine con esperar_subagentes.`;
        if (deps.sessionRef.current.isRequestActive) {
          stepControllerRef.interruptCurrentStepForCorrection(resumeMsg);
        } else {
          startOrEnqueuePrompt(resumeMsg);
        }
      }
      return { status: 'relaunched' };
    }

    if (!isAmbiguous) {
      sendSubagentCorrection(sub.id, clean);
    }

    const priorityParentNotice = isAmbiguous
      ? `[CORRECCIÓN PRIORITARIA DEL USUARIO PARA SUBAGENTE ${sub.name} (${sub.id})]: "${clean}". Asúmela sin pedir confirmación, reformúlala de forma clara para la bandeja del subagente y espera a los subagentes.`
      : `[CORRECCIÓN PRIORITARIA DEL USUARIO PARA SUBAGENTE ${sub.name} (${sub.id})]: "${clean}". Asúmela como contexto prioritario sin pedir confirmación (ya fue enviada tal cual a la bandeja de entrada del subagente) y retoma esperando a los subagentes.`;

    if (deps.sessionRef.current.isRequestActive) {
      stepControllerRef.interruptCurrentStepForCorrection(priorityParentNotice);
    } else {
      startOrEnqueuePrompt(priorityParentNotice);
    }

    return { status: 'sent_live' };
  };

  const injectBtwNote = (noteText: string) => {
    const clean = noteText.trim();
    if (!clean) return;
    if (deps.sessionRef.current.isRequestActive) {
      stepControllerRef.injectBtwThoughtNote?.(clean);
      deps.addSystemMessage(`[btw -> pensamiento en vivo] ${clean}`);
    } else {
      pendingIdleBtwNotes.push(clean);
      deps.addSystemMessage(`[btw -> cadena de pensamiento] ${clean}`);
    }
  };

  return {
    startOrEnqueuePrompt,
    cancelCurrentTurnAndQueue,
    injectBtwNote,
    submitSubagentCorrection,
  };
}
