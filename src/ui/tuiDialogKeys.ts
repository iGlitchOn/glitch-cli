import type { Key } from 'ink';
import type { ModelDefinition, ModelFamilyPage } from '../config/models.js';
import type { GlitchSettings } from '../config/settings.js';
import {
  snapshotPastedImageMap,
  transformPastedChunkWithImages,
} from '../core/clipboard.js';
import {
  InputUndoManager,
  deleteBackwardAtCursor,
  deleteForwardAtCursor,
  deleteWordBackwardAtCursor,
  insertTextAtCursor,
  moveCursorEnd,
  moveCursorHome,
  moveCursorLeft,
  moveCursorRight,
  type LineEditorState,
} from '../core/lineEditor.js';
import type { McpServerEntry } from '../core/mcpRegistry.js';
import type { SessionState } from '../core/session.js';
import type { SavedSession } from '../core/sessionStore.js';
import { countRealUserTurns } from '../core/sessionStore.js';
import { formatSkillTokens, type SkillInfo } from '../core/skills.js';
import {
  cancelSubagentById,
  continueSubagentFromLimit,
  type LiveSubagentInfo,
} from '../core/subagents.js';
import {
  filterSavedSessionsForPanel,
  getVisibleSubagentsForPanel,
  type ActiveTerminalChatEntry,
} from './AgentsPanelView.js';
import type { ActiveDialog, PendingAskUserPrompt } from './DialogsView.js';
import { handleConfigDialogKeys } from './tuiConfigDialogKeys.js';
export interface DialogKeyHandlerContext {
  activeDialog: ActiveDialog;
  session: SessionState;
  sessionId?: string;
  settings: GlitchSettings;
  dialogCursor: number;
  savedSessionsList: readonly SavedSession[];
  liveSubagents?: readonly LiveSubagentInfo[];
  activeChats?: readonly ActiveTerminalChatEntry[];
  selectedSubagentId?: string | null;
  correctionInputText?: string;
  pendingRelaunchConfirm?: boolean;
  showAllHistorySessions?: boolean;
  showAllAgentsHistory?: boolean;
  setSelectedSubagentId?: (id: string | null) => void;
  setCorrectionInputText?: React.Dispatch<React.SetStateAction<string>>;
  setPendingRelaunchConfirm?: (v: boolean) => void;
  setShowAllHistorySessions?: React.Dispatch<React.SetStateAction<boolean>>;
  setShowAllAgentsHistory?: React.Dispatch<React.SetStateAction<boolean>>;
  onSwitchActiveChat?: (chatId: string) => void;
  onCreateNewActiveChat?: () => void;
  setAgentsPanelNotice?: (msg: string) => void;
  onSubmitSubagentCorrection?: (
    sub: LiveSubagentInfo,
    correctionText: string,
    relaunchIfFinished?: boolean,
  ) => { status: 'sent_live' | 'needs_relaunch_confirm' | 'relaunched' };
  authStep:
    | 'provider'
    | 'vertex_project'
    | 'vertex_location'
    | 'custom_url'
    | 'custom_key'
    | 'custom_format';
  authChoiceIdx: number;
  authBuffer: string;
  tempProject: string;
  tempUrl: string;
  tempKey: string;
  modelPages: readonly ModelFamilyPage[];
  modelPageIdx: number;
  pendingModelForEffort: ModelDefinition | null;
  modelEffortIdx: number;
  editingThresholdMode: boolean;
  thresholdBuffer: string;
  pendingAskUser: PendingAskUserPrompt | null;
  askUserCursor: number;
  askUserCustomText: string;
  askUserCustomCursor: number;
  askUserTypingCustom: boolean;
  askUserUndoManager: InputUndoManager;
  mcpServers: readonly McpServerEntry[];
  installedSkills: readonly SkillInfo[];
  activeSkillContents: Map<string, string>;
  setActiveDialog: (dlg: ActiveDialog) => void;
  setDialogCursor: React.Dispatch<React.SetStateAction<number>>;
  resumeSavedSessionUi: (found: SavedSession, prefixText?: string) => void;
  setAuthChoiceIdx: React.Dispatch<React.SetStateAction<number>>;
  setAuthBuffer: React.Dispatch<React.SetStateAction<string>>;
  setAuthStep: (
    step:
      | 'provider'
      | 'vertex_project'
      | 'vertex_location'
      | 'custom_url'
      | 'custom_key'
      | 'custom_format',
  ) => void;
  setTempProject: (v: string) => void;
  setTempUrl: (v: string) => void;
  setTempKey: (v: string) => void;
  syncSettings: (next: GlitchSettings) => void;
  addSystemMessage: (text: string) => void;
  refreshModels: (cfg: GlitchSettings) => Promise<void>;
  setPendingModelForEffort: (m: ModelDefinition | null) => void;
  setModelEffortIdx: React.Dispatch<React.SetStateAction<number>>;
  setModelPageIdx: React.Dispatch<React.SetStateAction<number>>;
  setEditingThresholdMode: (v: boolean) => void;
  setThresholdBuffer: React.Dispatch<React.SetStateAction<string>>;
  setThresholdError: (v: string) => void;
  setAskUserTypingCustom: (v: boolean) => void;
  setPendingAskUser: (p: PendingAskUserPrompt | null) => void;
  setAskUserCursor: React.Dispatch<React.SetStateAction<number>>;
  applyAskUserCustomState: (next: LineEditorState) => void;
  syncActiveSkillsFromSet: (names: Set<string>) => void;
}
export function handleActiveDialogInput(
  input: string,
  key: Key,
  ctx: DialogKeyHandlerContext,
): boolean {
  const lowerInput = input.toLowerCase();
  if (handleConfigDialogKeys(input, key, ctx)) {
    return true;
  }
  if (ctx.activeDialog === 'ask_user' && ctx.pendingAskUser) {
    const customOptionIdx = ctx.pendingAskUser.options.length;
    const totalChoices = ctx.pendingAskUser.options.length + 1;
    if (ctx.askUserTypingCustom) {
      if (key.escape && ctx.pendingAskUser.options.length > 0) {
        ctx.setAskUserTypingCustom(false);
        return true;
      }
      if (key.return) {
        const ans = ctx.askUserCustomText.trim();
        if (!ans) return true;
        ctx.askUserUndoManager.clear();
        const resolver = ctx.pendingAskUser.resolve;
        ctx.setPendingAskUser(null);
        ctx.setActiveDialog('none');
        resolver(ans);
        return true;
      }
      if (key.leftArrow) {
        ctx.askUserUndoManager.breakGroup();
        ctx.applyAskUserCustomState(
          moveCursorLeft(
            { text: ctx.askUserCustomText, cursor: ctx.askUserCustomCursor },
            key.ctrl || key.meta,
          ),
        );
        return true;
      }
      if (key.rightArrow) {
        ctx.askUserUndoManager.breakGroup();
        ctx.applyAskUserCustomState(
          moveCursorRight(
            { text: ctx.askUserCustomText, cursor: ctx.askUserCustomCursor },
            key.ctrl || key.meta,
          ),
        );
        return true;
      }
      if (key.home || (key.ctrl && lowerInput === 'a')) {
        ctx.askUserUndoManager.breakGroup();
        ctx.applyAskUserCustomState(
          moveCursorHome({
            text: ctx.askUserCustomText,
            cursor: ctx.askUserCustomCursor,
          }),
        );
        return true;
      }
      if (key.end || (key.ctrl && lowerInput === 'e')) {
        ctx.askUserUndoManager.breakGroup();
        ctx.applyAskUserCustomState(
          moveCursorEnd({
            text: ctx.askUserCustomText,
            cursor: ctx.askUserCustomCursor,
          }),
        );
        return true;
      }
      if (
        ((key.backspace || key.delete) && (key.shift || key.ctrl || key.meta)) ||
        (key.ctrl && lowerInput === 'w')
      ) {
        const beforeState = {
          text: ctx.askUserCustomText,
          cursor: ctx.askUserCustomCursor,
        };
        const nextState = deleteWordBackwardAtCursor(beforeState);
        ctx.askUserUndoManager.recordEdit(beforeState, nextState, 'delete_word');
        ctx.applyAskUserCustomState(nextState);
        return true;
      }
      if (key.backspace || key.delete) {
        const beforeState = {
          text: ctx.askUserCustomText,
          cursor: ctx.askUserCustomCursor,
        };
        const nextState = key.backspace
          ? deleteBackwardAtCursor(beforeState)
          : deleteForwardAtCursor(beforeState);
        ctx.askUserUndoManager.recordEdit(beforeState, nextState, 'delete_char');
        ctx.applyAskUserCustomState(nextState);
        return true;
      }
      if (input && !key.ctrl && !key.meta) {
        const beforeRefs = snapshotPastedImageMap();
        const processed = transformPastedChunkWithImages(input);
        const beforeState = {
          text: ctx.askUserCustomText,
          cursor: ctx.askUserCustomCursor,
        };
        const nextState = insertTextAtCursor(beforeState, processed);
        const actionKind =
          input.length > 1 || processed !== input ? 'paste' : 'type_char';
        ctx.askUserUndoManager.recordEdit(
          beforeState,
          nextState,
          actionKind,
          processed,
          Date.now(),
          beforeRefs,
        );
        ctx.applyAskUserCustomState(nextState);
      }
      return true;
    }
    if (key.upArrow && totalChoices > 0) {
      ctx.setAskUserCursor((prev) => (prev > 0 ? prev - 1 : totalChoices - 1));
      return true;
    }
    if (key.downArrow && totalChoices > 0) {
      ctx.setAskUserCursor((prev) => (prev < totalChoices - 1 ? prev + 1 : 0));
      return true;
    }
    if (key.return) {
      if (ctx.askUserCursor === customOptionIdx) {
        ctx.setAskUserTypingCustom(true);
        return true;
      }
      const chosenOpt = ctx.pendingAskUser.options[ctx.askUserCursor];
      if (chosenOpt) {
        const resolver = ctx.pendingAskUser.resolve;
        ctx.setPendingAskUser(null);
        ctx.setActiveDialog('none');
        resolver(chosenOpt);
      }
    }
    return true;
  }
  if (ctx.activeDialog === 'agents_chats') {
    const subagents = ctx.liveSubagents ?? [];
    const selectedSub = ctx.selectedSubagentId
      ? subagents.find((s) => s.id === ctx.selectedSubagentId)
      : undefined;

    // Vista de detalle de un subagente con input de corrección
    if (selectedSub) {
      if (key.escape) {
        if (ctx.pendingRelaunchConfirm) {
          ctx.setPendingRelaunchConfirm?.(false);
        } else {
          ctx.setSelectedSubagentId?.(null);
          ctx.setCorrectionInputText?.('');
          ctx.setPendingRelaunchConfirm?.(false);
        }
        return true;
      }
      const curCorrection = ctx.correctionInputText ?? '';
      if (curCorrection.length === 0 && lowerInput === 'c' && !key.ctrl && !key.meta) {
        if (selectedSub.status === 'limite') {
          void continueSubagentFromLimit(selectedSub.id);
          ctx.setAgentsPanelNotice?.(`Continuando ${selectedSub.name}...`);
        }
        return true;
      }
      if (curCorrection.length === 0 && lowerInput === 'x' && !key.ctrl && !key.meta) {
        if (selectedSub.status === 'running') {
          cancelSubagentById(selectedSub.id);
          ctx.setAgentsPanelNotice?.(`Cancelado ${selectedSub.name}`);
        }
        return true;
      }
      if (key.return) {
        const trimmedCorr = curCorrection.trim();
        if (!trimmedCorr) return true;
        const res = ctx.onSubmitSubagentCorrection?.(
          selectedSub,
          trimmedCorr,
          Boolean(ctx.pendingRelaunchConfirm),
        );
        if (res?.status === 'needs_relaunch_confirm') {
          ctx.setPendingRelaunchConfirm?.(true);
          return true;
        }
        ctx.setCorrectionInputText?.('');
        ctx.setPendingRelaunchConfirm?.(false);
        ctx.setSelectedSubagentId?.(null);
        ctx.setActiveDialog('none');
        return true;
      }
      if (
        ((key.backspace || key.delete) && (key.shift || key.ctrl || key.meta)) ||
        (key.ctrl && lowerInput === 'w')
      ) {
        ctx.setCorrectionInputText?.(
          (prev) =>
            deleteWordBackwardAtCursor({ text: prev, cursor: prev.length }).text,
        );
        ctx.setPendingRelaunchConfirm?.(false);
        return true;
      }
      if (key.backspace || key.delete) {
        ctx.setCorrectionInputText?.((prev) => prev.slice(0, -1));
        ctx.setPendingRelaunchConfirm?.(false);
        return true;
      }
      if (input && !key.ctrl && !key.meta) {
        ctx.setCorrectionInputText?.((prev) => prev + input);
        ctx.setPendingRelaunchConfirm?.(false);
      }
      return true;
    }

    const visibleSubs = getVisibleSubagentsForPanel(
      subagents,
      Boolean(ctx.showAllAgentsHistory),
    );
    const effectiveActiveChats: ActiveTerminalChatEntry[] =
      ctx.activeChats && ctx.activeChats.length > 0
        ? [...ctx.activeChats]
        : [
            {
              id: ctx.sessionId ?? 'current',
              title: 'Conversación actual',
              turnCount: 0,
              isStreaming: false,
              isCurrent: true,
              model: ctx.settings.model,
            },
          ];
    const activeIds = new Set(effectiveActiveChats.map((c) => c.id));
    const filteredHistory = filterSavedSessionsForPanel(
      ctx.savedSessionsList,
      ctx.sessionId ?? '',
      Boolean(ctx.showAllHistorySessions),
      6,
      activeIds,
    );
    const totalEntries =
      1 +
      visibleSubs.length +
      effectiveActiveChats.length +
      1 +
      filteredHistory.visibleSessions.length +
      (filteredHistory.showToggleAllOption ? 1 : 0);

    if (key.escape || key.rightArrow) {
      ctx.setAgentsPanelNotice?.('');
      ctx.setActiveDialog('none');
      return true;
    }
    if (key.upArrow && totalEntries > 0) {
      ctx.setAgentsPanelNotice?.('');
      ctx.setDialogCursor((prev) => (prev > 0 ? prev - 1 : totalEntries - 1));
      return true;
    }
    if (key.downArrow && totalEntries > 0) {
      ctx.setAgentsPanelNotice?.('');
      ctx.setDialogCursor((prev) => (prev < totalEntries - 1 ? prev + 1 : 0));
      return true;
    }
    if (lowerInput === 'c' && !key.ctrl && !key.meta) {
      const subAtCursor =
        ctx.dialogCursor >= 1 && ctx.dialogCursor <= visibleSubs.length
          ? visibleSubs[ctx.dialogCursor - 1]
          : undefined;
      if (subAtCursor && subAtCursor.status === 'limite') {
        void continueSubagentFromLimit(subAtCursor.id);
        ctx.setAgentsPanelNotice?.(`Continuando ${subAtCursor.name}...`);
      }
      return true;
    }
    if (lowerInput === 'x' && !key.ctrl && !key.meta) {
      const subAtCursor =
        ctx.dialogCursor >= 1 && ctx.dialogCursor <= visibleSubs.length
          ? visibleSubs[ctx.dialogCursor - 1]
          : undefined;
      if (subAtCursor && subAtCursor.status === 'running') {
        cancelSubagentById(subAtCursor.id);
        ctx.setAgentsPanelNotice?.(`Cancelado ${subAtCursor.name}`);
      }
      return true;
    }
    if (key.return) {
      // 0 -> AGENTES ▼ (alternar historial de agentes)
      if (ctx.dialogCursor === 0) {
        ctx.setShowAllAgentsHistory?.((prev) => !prev);
        return true;
      }
      // 1 .. visibleSubs.length -> agentes visibles
      if (ctx.dialogCursor >= 1 && ctx.dialogCursor <= visibleSubs.length) {
        const pickedSub = visibleSubs[ctx.dialogCursor - 1];
        if (pickedSub) {
          ctx.setSelectedSubagentId?.(pickedSub.id);
          ctx.setCorrectionInputText?.('');
          ctx.setPendingRelaunchConfirm?.(false);
        }
        return true;
      }
      // Chats activos
      const activeStart = 1 + visibleSubs.length;
      const activeEnd = activeStart + effectiveActiveChats.length;
      if (ctx.dialogCursor >= activeStart && ctx.dialogCursor < activeEnd) {
        const pickedActive = effectiveActiveChats[ctx.dialogCursor - activeStart];
        if (pickedActive) {
          if (!pickedActive.isCurrent) {
            ctx.onSwitchActiveChat?.(pickedActive.id);
          }
          ctx.setActiveDialog('none');
        }
        return true;
      }
      // + Nuevo chat activo
      if (ctx.dialogCursor === activeEnd) {
        ctx.onCreateNewActiveChat?.();
        ctx.setActiveDialog('none');
        return true;
      }
      // Historial
      const histStart = activeEnd + 1;
      const histOffset = ctx.dialogCursor - histStart;
      if (histOffset >= 0 && histOffset < filteredHistory.visibleSessions.length) {
        const picked = filteredHistory.visibleSessions[histOffset];
        if (picked) {
          const realTurns = countRealUserTurns(picked);
          ctx.resumeSavedSessionUi(
            picked,
            `Cambiado al chat: "${picked.title}" (${realTurns} ${realTurns === 1 ? 'turno' : 'turnos'}).`,
          );
        }
        ctx.setActiveDialog('none');
        return true;
      }
      if (filteredHistory.showToggleAllOption) {
        ctx.setShowAllHistorySessions?.((prev) => !prev);
      }
    }
    return true;
  }
  if (ctx.activeDialog === 'resume') {
    if (key.escape) {
      ctx.setActiveDialog('none');
      return true;
    }
    if (key.upArrow && ctx.savedSessionsList.length > 0) {
      ctx.setDialogCursor((prev) =>
        prev > 0 ? prev - 1 : ctx.savedSessionsList.length - 1,
      );
      return true;
    }
    if (key.downArrow && ctx.savedSessionsList.length > 0) {
      ctx.setDialogCursor((prev) =>
        prev < ctx.savedSessionsList.length - 1 ? prev + 1 : 0,
      );
      return true;
    }
    if (key.return) {
      const picked = ctx.savedSessionsList[ctx.dialogCursor];
      if (picked) {
        ctx.resumeSavedSessionUi(
          picked,
          `Conversación retomada: "${picked.title}" (${picked.history.length} turnos).`,
        );
      }
      ctx.setActiveDialog('none');
    }
    return true;
  }
  if (ctx.activeDialog === 'mcp') {
    if (key.escape || key.return) {
      ctx.setActiveDialog('none');
      return true;
    }
    if (key.upArrow && ctx.mcpServers.length > 0) {
      ctx.setDialogCursor((prev) => (prev > 0 ? prev - 1 : ctx.mcpServers.length - 1));
      return true;
    }
    if (key.downArrow && ctx.mcpServers.length > 0) {
      ctx.setDialogCursor((prev) => (prev < ctx.mcpServers.length - 1 ? prev + 1 : 0));
    }
    return true;
  }
  if (ctx.activeDialog === 'skills') {
    if (key.escape) {
      ctx.setActiveDialog('none');
      return true;
    }
    if (key.upArrow && ctx.installedSkills.length > 0) {
      ctx.setDialogCursor((prev) => (prev > 0 ? prev - 1 : ctx.installedSkills.length - 1));
      return true;
    }
    if (key.downArrow && ctx.installedSkills.length > 0) {
      ctx.setDialogCursor((prev) => (prev < ctx.installedSkills.length - 1 ? prev + 1 : 0));
      return true;
    }
    if (key.leftArrow && ctx.installedSkills.length > 0) {
      ctx.setDialogCursor((prev) => Math.max(0, prev - 10));
      return true;
    }
    if (key.rightArrow && ctx.installedSkills.length > 0) {
      ctx.setDialogCursor((prev) => Math.min(ctx.installedSkills.length - 1, prev + 10));
      return true;
    }
    if (key.return && ctx.installedSkills.length > 0) {
      const picked = ctx.installedSkills[ctx.dialogCursor];
      if (picked) {
        const nextSet = new Set(ctx.activeSkillContents.keys());
        if (nextSet.has(picked.name)) {
          nextSet.delete(picked.name);
          ctx.addSystemMessage(`Skill "${picked.name}" desactivada del contexto de sesión.`);
        } else {
          nextSet.add(picked.name);
          ctx.addSystemMessage(
            `Skill "${picked.name}" activada desde ${picked.filePath} (${formatSkillTokens(picked.approxTokens)}).`,
          );
        }
        ctx.syncActiveSkillsFromSet(nextSet);
      }
    }
    return true;
  }
  if (ctx.activeDialog === 'usage') {
    if (key.escape || key.return) {
      ctx.setActiveDialog('none');
    }
    return true;
  }
  return false;
}
