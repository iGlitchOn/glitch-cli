import React, { useState, useRef, useMemo } from 'react';
import { Box, Text, useApp, useInput, usePaste, useStdin, useStdout, type DOMElement } from 'ink';
import { getAppVersion, isAuthConfigured, saveSettings, type GlitchSettings } from '../config/settings.js';
import { LOCAL_GOOGLE_MODELS, getModelContextWindow, groupModelsByFamilyPages, listVertexGoogleModels, type ModelDefinition } from '../config/models.js';
import { matchSlashCommands } from '../commands/slashRegistry.js';
import { computeChatCostSummary, computeContextUsageBreakdown, type CostRequestRecord } from './statusBar.js';
import { BRACKETED_PASTE_START, BracketedPasteParser, normalizePastedText, readWindowsClipboard, snapshotPastedImageMap } from '../core/clipboard.js';
import { createCompactionTracker, type CompactionTracker } from '../core/compaction.js';
import { InputUndoManager, applyBracketedPasteToEditor, insertTextAtCursor, type LineEditorState } from '../core/lineEditor.js';
import { discoverMcpServers, type McpServerEntry } from '../core/mcpRegistry.js';
import { SessionState } from '../core/session.js';
import { createSessionId, countRealUserTurns, deriveSessionTitle, listSavedSessions, saveSessionToDisk, scheduleSaveSessionToDisk, type SavedSession, type SavedUiMessage } from '../core/sessionStore.js';
import { discoverInstalledSkills, type SkillInfo } from '../core/skills.js';
import type { LiveSubagentInfo } from '../core/subagents.js';
import { createVertexGenAI } from '../providers/vertex.js';
import type { ApiTokenUsage } from '../providers/types.js';
import { AgentsPanelView, type ActiveTerminalChatEntry } from './AgentsPanelView.js';
import { ChatHistoryView, type NumberedUiMessage } from './ChatHistoryView.js';
import { DaaSplashView, DialogsView, type ActiveDialog, type PendingAskUserPrompt } from './DialogsView.js';
import { HeaderBanner } from './HeaderBanner.js';
import { InputBoxView } from './InputBoxView.js';
import { UsageStatsCard } from './InspectorDialogsView.js';
import { buildLineLinkMap } from './markdownTokens.js';
import { StatusBarBottom, StatusBarTop } from './StatusBarView.js';
import { executeTuiInputCommand, handleActiveDialogInput, handleMainEditorKeyInput } from './tuiInputHandlers.js';
import { computeEffectiveScrollTop, computeScrollbarThumb, dispatchSgrMouseEvents, formatScrollToBottomLabel, readTerminalSize, scrollChatStateBy, shouldShowHeaderForRows, shouldShowScrollToBottomButton, type ChatScrollState, type SgrMouseEvent } from './tuiScrollMouse.js';
import { useTerminalEffects } from './useTerminalEffects.js';
import { createTurnPromptActions } from './useTurnPromptRunner.js';
export * from './tuiScrollMouse.js';
export interface TuiAppProps {
  initialSettings: GlitchSettings;
  version?: string;
  launchedWithDaaFlag?: boolean;
  initialPrompt?: string;
}
export const TuiApp: React.FC<TuiAppProps> = ({
  initialSettings,
  version = getAppVersion(),
  launchedWithDaaFlag = false,
  initialPrompt,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin } = useStdin();
  const [termSize, setTermSize] = useState(() => readTerminalSize(stdout));
  const columns = termSize.columns;
  const rows = termSize.rows;
  const chatViewportRef = useRef<DOMElement>(null);
  const chatContentRef = useRef<DOMElement>(null);
  const [scrollState, setScrollState] = useState<ChatScrollState>({ scrollTop: 0, isAtBottom: true });
  const scrollStateRef = useRef<ChatScrollState>({ scrollTop: 0, isAtBottom: true });
  const maxScrollTopRef = useRef<number>(0);
  const sessionRef = useRef<SessionState>(new SessionState(initialSettings));
  const [sessionId, setSessionId] = useState<string>(() => createSessionId());
  const sessionCreatedAtRef = useRef<string>(new Date().toISOString());
  const [installedSkills] = useState<SkillInfo[]>(() => discoverInstalledSkills());
  const [mcpServers] = useState<McpServerEntry[]>(() => discoverMcpServers());
  const [activeSkillNames, setActiveSkillNames] = useState<string[]>([]);
  const activeSkillContentsRef = useRef<Map<string, string>>(new Map());
  const syncActiveSkillsFromSet = (namesSet: Set<string>) => {
    const nextMap = new Map<string, string>();
    for (const s of installedSkills) {
      if (namesSet.has(s.name)) nextMap.set(s.name, s.content);
    }
    activeSkillContentsRef.current = nextMap;
    setActiveSkillNames(Array.from(nextMap.keys()));
  };
  const [settings, setSettings] = useState<GlitchSettings>(initialSettings);
  const [availableModels, setAvailableModels] = useState(sessionRef.current.availableModels);
  const [daaSplashSeconds, setDaaSplashSeconds] = useState<number>(
    launchedWithDaaFlag && !initialSettings.hideDaaWarning ? 3 : 0,
  );
  const [messages, setMessages] = useState<SavedUiMessage[]>([]);
  const messagesRef = useRef<SavedUiMessage[]>([]);
  const [showShortcutsPanel, setShowShortcutsPanel] = useState(false);
  const [inputText, setInputText] = useState('');
  const [inputCursor, setInputCursor] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompactingContext, setIsCompactingContext] = useState(false);
  const compactionTrackerRef = useRef<CompactionTracker>(createCompactionTracker());
  const [editingThresholdMode, setEditingThresholdMode] = useState(false);
  const [thresholdBuffer, setThresholdBuffer] = useState('');
  const [thresholdError, setThresholdError] = useState('');
  const [streamingElapsedMs, setStreamingElapsedMs] = useState(0);
  const streamStartTimeRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [liveThought, setLiveThought] = useState('');
  const [liveText, setLiveText] = useState('');
  const [thoughtsCollapsed, setThoughtsCollapsed] = useState<boolean | null>(null);
  const [perMessageCollapsed, setPerMessageCollapsed] = useState<Record<string, boolean>>({});
  const [selectionMode, setSelectionMode] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [transientStatusNotice, setTransientStatusNotice] = useState('');
  const [seenMsgCountAtBottom, setSeenMsgCountAtBottom] = useState(0);
  const [sessionCostUsd, setSessionCostUsd] = useState<number | null>(null);
  const [lastTurnCostUsd, setLastTurnCostUsd] = useState<number | null>(null);
  const [currentTurnCostUsd, setCurrentTurnCostUsd] = useState<number | null>(null);
  const [costRecords, setCostRecords] = useState<CostRequestRecord[]>([]);
  const [liveInFlightUsage, setLiveInFlightUsage] = useState<ApiTokenUsage | undefined>(undefined);
  const [liveInFlightModelId, setLiveInFlightModelId] = useState<string | undefined>(undefined);
  const [lastApiPromptTokens, setLastApiPromptTokens] = useState<number | null>(null);
  const [lastTurnDurationText, setLastTurnDurationText] = useState('0s');
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(() =>
    isAuthConfigured(initialSettings) ? 'none' : 'auth',
  );
  const [suggestionIdx, setSuggestionIdx] = useState(0);
  const [ctrlCPending, setCtrlCPending] = useState(false);
  const queueRef = useRef<string[]>([]);
  const [queuedPrompts, setQueuedPrompts] = useState<string[]>([]);
  const [editingQueueIdx, setEditingQueueIdx] = useState<number | null>(null);
  const [confirmDeleteQueueIdx, setConfirmDeleteQueueIdx] = useState<number | null>(null);
  const originalEditingQueueTextRef = useRef<string>('');
  const draftInputRef = useRef<string>('');
  const [authStep, setAuthStep] = useState<
    'provider' | 'vertex_project' | 'vertex_location' | 'custom_url' | 'custom_key' | 'custom_format'
  >('provider');
  const [authChoiceIdx, setAuthChoiceIdx] = useState(0);
  const [authBuffer, setAuthBuffer] = useState('');
  const [tempProject, setTempProject] = useState(
    initialSettings.vertex?.project || process.env['GOOGLE_CLOUD_PROJECT'] || '',
  );
  const [tempUrl, setTempUrl] = useState(initialSettings.custom?.baseUrl || 'https://api.openai.com');
  const [tempKey, setTempKey] = useState('');
  const [dialogCursor, setDialogCursor] = useState(0);
  const [modelPageIdx, setModelPageIdx] = useState(0);
  const [pendingModelForEffort, setPendingModelForEffort] = useState<ModelDefinition | null>(null);
  const [modelEffortIdx, setModelEffortIdx] = useState(0);
  const [savedSessionsList, setSavedSessionsList] = useState<SavedSession[]>([]);
  const [liveSubagents, setLiveSubagents] = useState<LiveSubagentInfo[]>([]);
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);
  const [correctionInputText, setCorrectionInputText] = useState('');
  const [pendingRelaunchConfirm, setPendingRelaunchConfirm] = useState(false);
  const [showAllHistorySessions, setShowAllHistorySessions] = useState(false);
  const [showAllAgentsHistory, setShowAllAgentsHistory] = useState(false);
  const [agentsPanelNotice, setAgentsPanelNotice] = useState('');
  const activeChatsMapRef = useRef<Map<string, { session: SessionState; messages: SavedUiMessage[]; createdAt: string }>>(new Map());
  const [pendingAskUser, setPendingAskUser] = useState<PendingAskUserPrompt | null>(null);
  const [askUserCursor, setAskUserCursor] = useState(0);
  const [askUserCustomText, setAskUserCustomText] = useState('');
  const [askUserCustomCursor, setAskUserCustomCursor] = useState(0);
  const [askUserTypingCustom, setAskUserTypingCustom] = useState(false);
  const lastSubagentUiFlushRef = useRef<number>(0);
  const upsertLiveSubagent = (info: LiveSubagentInfo) => {
    const now = Date.now();
    if (info.status === 'running' && now - lastSubagentUiFlushRef.current < 100) return;
    lastSubagentUiFlushRef.current = now;
    setLiveSubagents((prev) => {
      const idx = prev.findIndex((s) => s.id === info.id);
      if (idx === -1) return [...prev.slice(-19), info];
      const next = [...prev];
      next[idx] = info;
      return next;
    });
  };
  const inputStateRef = useRef<LineEditorState>({ text: '', cursor: 0 });
  const askUserCustomStateRef = useRef<LineEditorState>({ text: '', cursor: 0 });
  const inputUndoManagerRef = useRef<InputUndoManager>(new InputUndoManager(100));
  const askUserUndoManagerRef = useRef<InputUndoManager>(new InputUndoManager(100));
  const bracketedPasteParserRef = useRef<BracketedPasteParser>(new BracketedPasteParser());
  const lastPasteTimeRef = useRef<number>(0);
  const applyInputState = (next: LineEditorState) => {
    inputStateRef.current = next;
    setInputText(next.text);
    setInputCursor(next.cursor);
  };
  const setFullInputText = (text: string) => applyInputState({ text, cursor: text.length });
  const applyAskUserCustomState = (next: LineEditorState) => {
    askUserCustomStateRef.current = next;
    setAskUserCustomText(next.text);
    setAskUserCustomCursor(next.cursor);
  };
  const updateScrollState = (next: ChatScrollState) => {
    scrollStateRef.current = next;
    setScrollState(next);
    if (next.isAtBottom) setSeenMsgCountAtBottom(messagesRef.current.length);
  };
  const readCurrentMaxScrollTop = (): number => {
    const vpLayoutH = chatViewportRef.current?.yogaNode?.getComputedLayout().height ?? 0;
    const contLayoutH = chatContentRef.current?.yogaNode?.getComputedLayout().height ?? 0;
    if (vpLayoutH > 0 && contLayoutH >= 0) return Math.max(0, contLayoutH - vpLayoutH);
    return maxScrollTopRef.current;
  };
  const scrollChatBy = (deltaRows: number) => {
    updateScrollState(scrollChatStateBy(scrollStateRef.current, deltaRows, readCurrentMaxScrollTop()));
  };
  const modelPages = groupModelsByFamilyPages(availableModels);
  const syncSettings = (next: GlitchSettings) => {
    sessionRef.current.settings = next;
    setSettings({ ...next });
    saveSettings(next);
  };
  const persistCurrentSession = (nextMessages: SavedUiMessage[], currentId = sessionId, syncImmediate = false) => {
    const history = sessionRef.current.history;
    if (history.length === 0) return;
    const cur = sessionRef.current;
    const curSettings = cur.settings;
    const payload: SavedSession = {
      id: currentId,
      title: deriveSessionTitle(nextMessages, history, cur.customTitle),
      customTitle: cur.customTitle,
      completedTurnsCount: cur.completedTurnsCount,
      titleGeneratedAtTurn: cur.titleGeneratedAtTurn,
      createdAt: sessionCreatedAtRef.current,
      updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      model: curSettings.model,
      effort: curSettings.effort,
      history: [...history],
      messages: nextMessages.filter((m) => m.role !== 'system'),
      sessionCostUsd: cur.sessionCostUsd,
      costRecords: [...cur.costRecords],
      lastApiPromptTokens: cur.lastApiPromptTokenCount,
    };
    if (syncImmediate) saveSessionToDisk(payload);
    else scheduleSaveSessionToDisk(payload);
  };
  const addSystemMessage = (text: string) => {
    setMessages((prev) => {
      const next: SavedUiMessage[] = [...prev, { id: `${Date.now()}-${Math.random()}`, role: 'system', text }];
      messagesRef.current = next;
      return next;
    });
  };
  const addUsageMessage = () => {
    setMessages((prev) => {
      const next: SavedUiMessage[] = [
        ...prev,
        {
          id: `${Date.now()}-${Math.random()}-usage`,
          role: 'system',
          text: 'Estadísticas de Sesión (/usage)',
          isUsageReport: true,
        },
      ];
      messagesRef.current = next;
      return next;
    });
    updateScrollState({ scrollTop: 0, isAtBottom: true });
  };
  const syncQueueState = () => setQueuedPrompts([...queueRef.current]);
  const refreshModels = async (cfg: GlitchSettings) => {
    if (cfg.provider === 'vertex' && cfg.vertex) {
      try {
        const list = await listVertexGoogleModels(createVertexGenAI(cfg.vertex));
        sessionRef.current.availableModels = list;
        setAvailableModels([...list]);
      } catch {
        sessionRef.current.availableModels = [...LOCAL_GOOGLE_MODELS];
        setAvailableModels([...LOCAL_GOOGLE_MODELS]);
      }
    }
  };
  const handlePastedTextBlock = (rawText: string) => {
    if (!rawText || daaSplashSeconds > 0) return;
    lastPasteTimeRef.current = Date.now();
    const normalized = normalizePastedText(rawText);
    if (!normalized) return;
    if (activeDialog === 'ask_user' && askUserTypingCustom) {
      applyAskUserCustomState(applyBracketedPasteToEditor(askUserCustomStateRef.current, normalized, askUserUndoManagerRef.current, Date.now()));
    } else if (activeDialog === 'auth') {
      setAuthBuffer((prev) => `${prev}${normalized.replace(/[\r\n]+/g, '')}`);
    } else if (activeDialog === 'none') {
      if (showShortcutsPanel) setShowShortcutsPanel(false);
      applyInputState(applyBracketedPasteToEditor(inputStateRef.current, normalized, inputUndoManagerRef.current, Date.now()));
      setSuggestionIdx(0);
    }
  };
  const handleClipboardPaste = () => {
    if (Date.now() - lastPasteTimeRef.current < 40) return;
    const beforeRefs = snapshotPastedImageMap();
    const clip = readWindowsClipboard();
    if (clip.kind === 'image' && clip.displayTag) {
      lastPasteTimeRef.current = Date.now();
      const inserted = `${clip.displayTag} `;
      if (activeDialog === 'ask_user' && askUserTypingCustom) {
        const beforeState = askUserCustomStateRef.current;
        const nextState = insertTextAtCursor(beforeState, inserted);
        askUserUndoManagerRef.current.recordEdit(beforeState, nextState, 'paste', inserted, Date.now(), beforeRefs);
        applyAskUserCustomState(nextState);
      } else if (activeDialog === 'none') {
        const beforeState = inputStateRef.current;
        const nextState = insertTextAtCursor(beforeState, inserted);
        inputUndoManagerRef.current.recordEdit(beforeState, nextState, 'paste', inserted, Date.now(), beforeRefs);
        applyInputState(nextState);
      }
    } else if (clip.kind === 'text' && clip.value) {
      handlePastedTextBlock(clip.value);
    }
  };
  const showTransientNotice = (msg: string, ms = 2000) => {
    setTransientStatusNotice(msg);
    setTimeout(() => setTransientStatusNotice(''), ms);
  };
  const lineLinkMap = useMemo(() => buildLineLinkMap(messages.flatMap((m) => m.text.split(/\r?\n/))), [messages]);
  const openAgentsPanelNow = (saved = listSavedSessions()) => {
    persistCurrentSession(messagesRef.current, sessionId, true);
    activeChatsMapRef.current.set(sessionId, {
      session: sessionRef.current,
      messages: [...messagesRef.current],
      createdAt: sessionCreatedAtRef.current,
    });
    setSavedSessionsList(saved);
    setSelectedSubagentId(null);
    setCorrectionInputText('');
    setPendingRelaunchConfirm(false);
    setAgentsPanelNotice('');
    setDialogCursor(1);
    setActiveDialog('agents_chats');
  };
  const handleSgrMouseEvents = (events: SgrMouseEvent[]) => {
    dispatchSgrMouseEvents({
      events, columns, rows, lineLinkMap, messages: messagesRef.current,
      isAtBottom: scrollStateRef.current.isAtBottom,
      readMaxScrollTop: readCurrentMaxScrollTop, updateScrollState,
      showTransientNotice, setThoughtsCollapsed,
      setCopiedMessageId: (id) => {
        setCopiedMessageId(id);
        setTimeout(() => setCopiedMessageId(null), 2000);
      },
      togglePerMessageCollapsed: (id) => setPerMessageCollapsed((prev) => ({ ...prev, [id]: !prev[id] })),
      onOpenAgentsPanel: () => openAgentsPanelNow(),
      onToggleShortcuts: () => setShowShortcutsPanel((prev) => !prev),
      onOpenModelDialog: () => {
        if (!sessionRef.current.isRequestActive) {
          setPendingModelForEffort(null);
          setDialogCursor(0);
          setActiveDialog('model');
        }
      },
      onOpenUsageDialog: () => { addUsageMessage(); },
      onOpenSettingsDialog: () => {
        setDialogCursor(0); setEditingThresholdMode(false);
        setThresholdError(''); setActiveDialog('settings');
      },
    });
  };
  usePaste((pastedText) => handlePastedTextBlock(pastedText));
  const matchingSlash = activeDialog === 'none' && confirmDeleteQueueIdx === null ? matchSlashCommands(inputText) : [];
  const { startOrEnqueuePrompt, cancelCurrentTurnAndQueue, submitSubagentCorrection } = createTurnPromptActions({
    sessionRef, streamStartTimeRef, abortControllerRef, messagesRef,
    activeSkillContentsRef, compactionTrackerRef, askUserUndoManagerRef, queueRef,
    installedSkills, mcpServers, setStreamingElapsedMs, setIsStreaming,
    setLiveThought, setLiveText, setMessages, setIsCompactingContext,
    setSettings, addSystemMessage, setLastTurnDurationText, persistCurrentSession,
    upsertLiveSubagent, setLiveSubagents, setActiveSkillNames, setLastApiPromptTokens,
    setCurrentTurnCostUsd, setLiveInFlightModelId, setLiveInFlightUsage,
    setCostRecords, setLastTurnCostUsd, setSessionCostUsd, setAskUserCursor,
    setAskUserCustomText, setAskUserCustomCursor, setAskUserTypingCustom,
    setPendingAskUser, setActiveDialog, setEditingQueueIdx, syncQueueState,
  });
  const resetNewSessionUi = (nextId: string) => {
    if (messagesRef.current.length > 0 || sessionRef.current.history.length > 0) {
      activeChatsMapRef.current.set(sessionId, {
        session: sessionRef.current,
        messages: [...messagesRef.current],
        createdAt: sessionCreatedAtRef.current,
      });
    }
    sessionRef.current = new SessionState(settings, availableModels);
    sessionCreatedAtRef.current = new Date().toISOString();
    setSessionId(nextId); setMessages([]); messagesRef.current = [];
    setCostRecords([]); setLiveInFlightUsage(undefined);
    setLiveInFlightModelId(undefined); setLastApiPromptTokens(null);
    setSessionCostUsd(null); setLastTurnCostUsd(null); setCurrentTurnCostUsd(null);
    updateScrollState({ scrollTop: 0, isAtBottom: true }); setShowShortcutsPanel(false);
  };
  const switchActiveChat = (targetId: string) => {
    activeChatsMapRef.current.set(sessionId, {
      session: sessionRef.current,
      messages: [...messagesRef.current],
      createdAt: sessionCreatedAtRef.current,
    });
    const target = activeChatsMapRef.current.get(targetId);
    if (!target) return;
    sessionRef.current = target.session;
    sessionCreatedAtRef.current = target.createdAt;
    setSessionId(targetId);
    setMessages([...target.messages]);
    messagesRef.current = [...target.messages];
    setCostRecords([...target.session.costRecords]);
    setSessionCostUsd(target.session.sessionCostUsd);
    setLastApiPromptTokens(target.session.lastApiPromptTokenCount);
    updateScrollState({ scrollTop: 0, isAtBottom: true });
  };
  const resumeSavedSessionUi = (found: SavedSession, noticeText?: string) => {
    sessionRef.current.restoreFromSavedSession(found);
    setSessionId(found.id);
    sessionCreatedAtRef.current = found.createdAt;
    setCostRecords([...sessionRef.current.costRecords]);
    setSessionCostUsd(sessionRef.current.sessionCostUsd);
    setLastApiPromptTokens(sessionRef.current.lastApiPromptTokenCount);
    setMessages([...found.messages, ...(noticeText ? [{ id: `${Date.now()}-resumed`, role: 'system' as const, text: noticeText }] : [])]);
  };
  const executeInputCommand = (raw: string) => {
    executeTuiInputCommand(raw, {
      session: sessionRef.current, settings, messages, sessionId,
      availableModels, modelPages, installedSkills,
      activeSkillContents: activeSkillContentsRef.current,
      lastTurnCostUsd, sessionCostUsd, persistCurrentSession, exit,
      setShowShortcutsPanel, addSystemMessage, addUsageMessage, resetNewSessionUi,
      resumeSavedSessionUi, setSavedSessionsList, setDialogCursor,
      setActiveDialog, setAuthStep, setAuthChoiceIdx, setAuthBuffer,
      setSettings, setEditingThresholdMode, setThresholdError,
      setPendingModelForEffort, setModelPageIdx, syncActiveSkillsFromSet,
      startOrEnqueuePrompt,
    });
  };
  useTerminalEffects({
    stdout: stdout as NodeJS.WriteStream, stdin: stdin as NodeJS.ReadStream,
    initialSettings, daaSplashSeconds, isStreaming, ctrlCPending, selectionMode,
    streamStartTimeRef, inputUndoManagerRef, inputStateRef, setDaaSplashSeconds,
    addSystemMessage, setStreamingElapsedMs, setCtrlCPending, refreshModels,
    applyInputState, setTermSize, scrollChatBy, handleClipboardPaste,
    onSgrMouseEvents: handleSgrMouseEvents, initialPrompt, onInitialPrompt: executeInputCommand,
  });
  useInput((input, key) => {
    if (bracketedPasteParserRef.current.isPasting() || input.includes(BRACKETED_PASTE_START)) {
      for (const seg of bracketedPasteParserRef.current.push(input)) {
        if (seg.kind === 'paste') handlePastedTextBlock(seg.text);
      }
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'c') {
      if (ctrlCPending) { persistCurrentSession(messages); exit(); } else setCtrlCPending(true);
      return;
    }
    const lowerInput = input.toLowerCase();
    const isRedo = (key.ctrl && lowerInput === 'y') || input === '\x19' || (key.ctrl && key.shift && lowerInput === 'z');
    const isUndo = !isRedo && ((key.ctrl && lowerInput === 'z') || input === '\x1a');
    if (isUndo) {
      if (activeDialog === 'ask_user' && askUserTypingCustom) {
        const prev = askUserUndoManagerRef.current.undo(askUserCustomStateRef.current);
        if (prev) applyAskUserCustomState(prev);
      } else if (activeDialog === 'none') {
        const prev = inputUndoManagerRef.current.undo(inputStateRef.current);
        if (prev) applyInputState(prev);
      }
      return;
    }
    if (isRedo) {
      if (activeDialog === 'ask_user' && askUserTypingCustom) {
        const next = askUserUndoManagerRef.current.redo(askUserCustomStateRef.current);
        if (next) applyAskUserCustomState(next);
      } else if (activeDialog === 'none') {
        const next = inputUndoManagerRef.current.redo(inputStateRef.current);
        if (next) applyInputState(next);
      }
      return;
    }
    if ((key.ctrl && lowerInput === 'v') || input === '\x16') { handleClipboardPaste(); return; }
    if (daaSplashSeconds > 0) return;
    if (activeDialog === 'none' && (key.pageUp || key.pageDown)) {
      const vpH = chatViewportRef.current?.yogaNode?.getComputedLayout().height ?? Math.max(4, rows - 10);
      scrollChatBy(key.pageUp ? -Math.max(1, vpH - 2) : Math.max(1, vpH - 2));
      return;
    }
    if (
      handleActiveDialogInput(input, key, {
        activeDialog, session: sessionRef.current, sessionId, settings, dialogCursor, savedSessionsList, liveSubagents, activeChats: activeChatsList,
        selectedSubagentId, correctionInputText, pendingRelaunchConfirm, showAllHistorySessions, showAllAgentsHistory,
        setSelectedSubagentId, setCorrectionInputText, setPendingRelaunchConfirm, setShowAllHistorySessions, setShowAllAgentsHistory,
        onSwitchActiveChat: switchActiveChat, onCreateNewActiveChat: () => resetNewSessionUi(createSessionId()),
        setAgentsPanelNotice, onSubmitSubagentCorrection: submitSubagentCorrection, authStep, authChoiceIdx, authBuffer,
        tempProject, tempUrl, tempKey, modelPages, modelPageIdx, pendingModelForEffort, modelEffortIdx, editingThresholdMode,
        thresholdBuffer, pendingAskUser, askUserCursor, askUserCustomText, askUserCustomCursor, askUserTypingCustom,
        askUserUndoManager: askUserUndoManagerRef.current, mcpServers, installedSkills, activeSkillContents: activeSkillContentsRef.current,
        setActiveDialog, setDialogCursor, resumeSavedSessionUi, setAuthChoiceIdx, setAuthBuffer, setAuthStep, setTempProject,
        setTempUrl, setTempKey, syncSettings, addSystemMessage, refreshModels, setPendingModelForEffort, setModelEffortIdx,
        setModelPageIdx, setEditingThresholdMode, setThresholdBuffer, setThresholdError, setAskUserTypingCustom, setPendingAskUser,
        setAskUserCursor, applyAskUserCustomState, syncActiveSkillsFromSet,
      })
    ) return;
    handleMainEditorKeyInput(input, key, {
      inputText, inputCursor, isStreaming, editingQueueIdx, confirmDeleteQueueIdx, matchingSlash, suggestionIdx,
      showShortcutsPanel, session: sessionRef.current, queueRef, draftInputRef, originalEditingQueueTextRef, inputStateRef,
      inputUndoManager: inputUndoManagerRef.current, abortCurrentTurn: cancelCurrentTurnAndQueue,
      syncQueueState, setConfirmDeleteQueueIdx, setEditingQueueIdx, setFullInputText, applyInputState, syncSettings, setThoughtsCollapsed,
      selectionMode, setSelectionMode, openAgentsPanel: (saved) => openAgentsPanelNow(saved),
      setShowShortcutsPanel, setSuggestionIdx, executeInputCommand, handlePastedTextBlock,
    });
  });
  const activeChatsList: ActiveTerminalChatEntry[] = useMemo(() => {
    const entries: ActiveTerminalChatEntry[] = [];
    for (const [id, entry] of activeChatsMapRef.current.entries()) {
      if (id === sessionId) continue;
      entries.push({
        id, title: deriveSessionTitle(entry.messages, entry.session.history, entry.session.customTitle),
        turnCount: countRealUserTurns({ history: entry.session.history, messages: entry.messages }),
        isStreaming: entry.session.isRequestActive, isCurrent: false, model: entry.session.settings.model,
      });
    }
    entries.unshift({
      id: sessionId, title: deriveSessionTitle(messages, sessionRef.current.history, sessionRef.current.customTitle),
      turnCount: countRealUserTurns({ history: sessionRef.current.history, messages }),
      isStreaming, isCurrent: true, model: settings.model,
    });
    return entries;
  }, [sessionId, messages, isStreaming, settings.model]);
  if (daaSplashSeconds > 0) return <DaaSplashView seconds={daaSplashSeconds} />;
  const { numberedMessages, userTurnCounter, modelTurnCounter } = useMemo(() => {
    let uCount = 0; let mCount = 0;
    const list: NumberedUiMessage[] = messages.map((m) => {
      if (m.role === 'user') return { ...m, turnNumber: ++uCount };
      if (m.role === 'model' && m.text.trim().length > 0) return { ...m, turnNumber: ++mCount };
      return { ...m, turnNumber: 0 };
    });
    return { numberedMessages: list, userTurnCounter: uCount, modelTurnCounter: mCount };
  }, [messages]);
  const activeSkillContentsList = useMemo(() => Array.from(activeSkillContentsRef.current.values()), [activeSkillNames]);
  const historyTurnLen = sessionRef.current.history.length;
  const activeModelContextWindow = getModelContextWindow(settings.model, settings.provider ?? 'vertex', settings.custom);
  const contextBreakdown = useMemo(
    () => computeContextUsageBreakdown(sessionRef.current.history, settings.subMode, installedSkills, activeSkillContentsList, activeModelContextWindow, mcpServers, lastApiPromptTokens),
    [historyTurnLen, messages.length, settings.subMode, installedSkills, activeSkillContentsList, activeModelContextWindow, mcpServers, lastApiPromptTokens],
  );
  const chatCostSummary = useMemo(
    () => computeChatCostSummary(costRecords, settings.model, settings.modelPricing, liveInFlightUsage, liveInFlightModelId, { regionalSurchargePct: settings.regionalSurchargePct }),
    [costRecords, settings.model, settings.modelPricing, liveInFlightUsage, liveInFlightModelId, settings.regionalSurchargePct],
  );
  const runningSubagents = liveSubagents.filter((s) => s.status === 'running');
  const activeAgentCount = 1 + runningSubagents.length;
  const showHeader = shouldShowHeaderForRows(rows);
  const uniformBoxWidth = Math.max(20, columns - 4);
  const uniformBoxInnerWidth = Math.max(10, uniformBoxWidth - 4);
  const maxInputBoxLines = Math.max(1, Math.min(10, Math.floor(rows * 0.35)));
  const visibleInputBoxLines = Math.min(Math.max(1, inputText.split('\n').length), maxInputBoxLines);
  const queueLinesEstimate = queuedPrompts.length > 0 && activeDialog === 'none' ? queuedPrompts.length * 2 + 3 : 0;
  const bottomZoneEstimate = 2 + visibleInputBoxLines + 2 + queueLinesEstimate + (isStreaming ? 1 : 0);
  const estimatedViewportHeight = Math.max(1, rows - (showHeader ? 5 : 0) - bottomZoneEstimate);
  const estimatedContentHeight = useMemo(
    () =>
      numberedMessages.reduce(
        (acc, m) => acc + (m.isUsageReport ? 16 : Math.max(1, m.text.split('\n').length) + 1),
        0,
      ),
    [numberedMessages],
  );
  const computedVpH = chatViewportRef.current?.yogaNode?.getComputedLayout().height ?? 0;
  const computedContH = chatContentRef.current?.yogaNode?.getComputedLayout().height ?? 0;
  const effectiveViewportHeight = computedVpH > 0 ? computedVpH : estimatedViewportHeight;
  const effectiveContentHeight = computedContH > 0 ? computedContH : estimatedContentHeight;
  const maxScrollTop = Math.max(0, effectiveContentHeight - effectiveViewportHeight);
  maxScrollTopRef.current = maxScrollTop;
  const effectiveScrollTop = computeEffectiveScrollTop(scrollState, maxScrollTop);
  const scrollbarMetrics = computeScrollbarThumb({
    trackHeight: Math.max(1, effectiveViewportHeight), contentHeight: effectiveContentHeight,
    viewportHeight: effectiveViewportHeight, scrollTop: effectiveScrollTop,
  });
  const showScrollBottomBtn = shouldShowScrollToBottomButton(scrollState, maxScrollTop);
  const newMsgsCount = scrollState.isAtBottom ? 0 : Math.max(0, messages.length - seenMsgCountAtBottom);
  const usageCardElement = (
    <UsageStatsCard
      settings={settings}
      activeSkillNames={activeSkillNames}
      contextBreakdown={contextBreakdown}
      historyTurnCount={sessionRef.current.history.length}
      costRecords={costRecords}
      chatCostSummary={chatCostSummary}
      lastTurnDurationText={lastTurnDurationText}
    />
  );
  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1} overflow="hidden">
      {showHeader && <Box flexDirection="column" flexShrink={0}><HeaderBanner settings={settings} version={version} /></Box>}
      <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
        <Box ref={chatViewportRef} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" contentOffsetY={effectiveScrollTop}>
          <Box ref={chatContentRef} flexDirection="column" flexShrink={0}>
            <ChatHistoryView
              numberedMessages={numberedMessages} uniformBoxWidth={uniformBoxWidth} uniformBoxInnerWidth={uniformBoxInnerWidth}
              thoughtsEnabled={settings.thoughts} thinkingDisplay={settings.thinkingDisplay ?? 'expandido'}
              thoughtsCollapsed={thoughtsCollapsed} perMessageCollapsed={perMessageCollapsed} copiedMessageId={copiedMessageId}
              isStreaming={isStreaming} liveThought={liveThought} liveText={liveText}
              nextStreamingReplyNumber={modelTurnCounter + 1} liveSubagents={liveSubagents}
              usageCardNode={usageCardElement}
            />
          </Box>
        </Box>
        {scrollbarMetrics.hasOverflow && (
          <Box flexDirection="column" width={1} flexShrink={0}>
            {Array.from({ length: scrollbarMetrics.trackHeight }, (_, idx) => {
              const inThumb = idx >= scrollbarMetrics.thumbTop && idx < scrollbarMetrics.thumbTop + scrollbarMetrics.thumbHeight;
              return <Text key={idx} color={inThumb ? 'cyan' : 'gray'} dimColor={!inThumb}>{inThumb ? '┃' : '│'}</Text>;
            })}
          </Box>
        )}
      </Box>
      {activeDialog === 'none' && showScrollBottomBtn && (
        <Box justifyContent="center" flexShrink={0}><Text color="cyan" bold>{`[${formatScrollToBottomLabel(newMsgsCount)}]`}</Text></Box>
      )}
      <Box flexDirection="column" flexShrink={0}>
        {activeDialog === 'agents_chats' && (
          <AgentsPanelView
            settings={settings} sessionId={sessionId} messages={messages} history={sessionRef.current.history}
            isStreaming={isStreaming} dialogCursor={dialogCursor} liveSubagents={liveSubagents}
            savedSessionsList={savedSessionsList} activeChats={activeChatsList} columns={columns}
            selectedSubagentId={selectedSubagentId} correctionInputText={correctionInputText}
            pendingRelaunchConfirm={pendingRelaunchConfirm} showAllHistorySessions={showAllHistorySessions}
            showAllAgentsHistory={showAllAgentsHistory} statusNotice={agentsPanelNotice}
          />
        )}
        <DialogsView
          activeDialog={activeDialog} settings={settings} version={version} dialogCursor={dialogCursor}
          savedSessionsList={savedSessionsList} authStep={authStep} authChoiceIdx={authChoiceIdx} authBuffer={authBuffer}
          modelPages={modelPages} modelPageIdx={modelPageIdx} pendingModelForEffort={pendingModelForEffort}
          modelEffortIdx={modelEffortIdx} editingThresholdMode={editingThresholdMode} thresholdBuffer={thresholdBuffer}
          thresholdError={thresholdError} pendingAskUser={pendingAskUser} askUserCursor={askUserCursor}
          askUserCustomText={askUserCustomText} askUserCustomCursor={askUserCustomCursor} askUserTypingCustom={askUserTypingCustom}
          mcpServers={mcpServers} installedSkills={installedSkills} activeSkillNames={activeSkillNames}
          activeSkillContents={activeSkillContentsRef.current} contextBreakdown={contextBreakdown}
          historyTurnCount={sessionRef.current.history.length} costRecords={costRecords}
          chatCostSummary={chatCostSummary} lastTurnDurationText={lastTurnDurationText} showShortcutsPanel={showShortcutsPanel}
        />
        {activeDialog === 'none' && (
          <>
            <StatusBarTop
              settings={settings} columns={columns} isStreaming={isStreaming} isCompactingContext={isCompactingContext}
              streamingElapsedMs={streamingElapsedMs} currentTurnCostUsd={currentTurnCostUsd}
              totalChatCostUsd={chatCostSummary.totalChatCostUsd} unknownPriceRequestCount={chatCostSummary.unknownPriceRequestCount}
              mcpCount={mcpServers.filter((m) => Boolean(m.active)).length} skillCount={activeSkillNames.length}
              maxContextTokens={activeModelContextWindow} totalUsedTokens={contextBreakdown.totalUsedTokens}
              runningSubagents={runningSubagents} selectionMode={selectionMode} thoughtsCollapsed={thoughtsCollapsed}
              transientStatusNotice={transientStatusNotice}
            />
            <InputBoxView
              inputText={inputText} inputCursor={inputCursor} columns={columns} maxInputBoxLines={maxInputBoxLines}
              userTurnCounter={userTurnCounter} editingQueueIdx={editingQueueIdx} confirmDeleteQueueIdx={confirmDeleteQueueIdx}
              ctrlCPending={ctrlCPending} queuedPrompts={queuedPrompts} matchingSlash={matchingSlash} suggestionIdx={suggestionIdx}
            />
          </>
        )}
        <StatusBarBottom settings={settings} activeAgentCount={activeAgentCount} isCompactingContext={isCompactingContext} />
      </Box>
    </Box>
  );
};
