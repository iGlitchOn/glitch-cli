import os from 'node:os';
import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Part } from '@google/genai';
import {
  formatAuthSummary,
  formatPermissionModeLabel,
  formatSubModeLabel,
  isAuthConfigured,
  maskApiKey,
  saveSettings,
  type AppLanguage,
  type CustomEndpointFormat,
  type EffortLevel,
  type GlitchSettings,
  type PermissionMode,
  type SubMode,
} from '../config/settings.js';
import {
  LOCAL_GOOGLE_MODELS,
  formatModelRowColumns,
  getModelDefinition,
  groupModelsByFamilyPages,
  listVertexGoogleModels,
  type ModelDefinition,
} from '../config/models.js';
import { runEffortCommand } from '../commands/effort.js';
import { parseModelAndEffortArgs } from '../commands/model.js';
import {
  SLASH_COMMANDS,
  matchSlashCommands,
  resolveSlashCommandAlias,
} from '../commands/slashRegistry.js';
import { toggleSubMode } from '../permissions/permissions.js';
import {
  GLITCH_ASCII_LINES,
  IGLITCHOFF_WORDMARK,
  formatShortCwd,
} from './banner.js';
import {
  detectEnvironmentCounts,
  formatInputTopLeftMode,
  formatInputTopRightInfo,
  formatStatusBar,
} from './statusBar.js';
import {
  formatCleanApiError,
  formatElapsedDuration,
  formatMessageTimestamp,
} from '../core/errorFormat.js';
import { SessionState } from '../core/session.js';
import {
  createSessionId,
  deriveSessionTitle,
  listSavedSessions,
  saveSessionToDisk,
  type SavedSession,
  type SavedUiMessage,
} from '../core/sessionStore.js';
import {
  VertexProviderAdapter,
  createVertexGenAI,
} from '../providers/vertex.js';
import { CustomProviderAdapter } from '../providers/custom.js';
import type { ProviderAdapter } from '../providers/types.js';

type ActiveDialog =
  | 'none'
  | 'auth'
  | 'model'
  | 'settings'
  | 'resume'
  | 'agents_chats';

export interface TuiAppProps {
  initialSettings: GlitchSettings;
  version?: string;
  launchedWithDaaFlag?: boolean;
}

export const TuiApp: React.FC<TuiAppProps> = ({
  initialSettings,
  version = '0.1.0',
  launchedWithDaaFlag = false,
}) => {
  const { exit } = useApp();
  useStdout();
  const columns = process.stdout.columns ?? 100;
  const rows = process.stdout.rows ?? 30;

  const sessionRef = useRef<SessionState>(new SessionState(initialSettings));
  const [sessionId, setSessionId] = useState<string>(() => createSessionId());
  const sessionCreatedAtRef = useRef<string>(new Date().toISOString());
  const [envCounts] = useState(() => detectEnvironmentCounts());

  const [settings, setSettings] = useState<GlitchSettings>(initialSettings);
  const lang: AppLanguage = settings.language ?? 'es';

  const [availableModels, setAvailableModels] = useState(
    sessionRef.current.availableModels,
  );

  // El aviso TUI de 3 segundos SOLO se muestra si se pasó la flag explícita (--DAA / --dangerously-always-allow)
  const shouldShowDaaSplash =
    launchedWithDaaFlag && !initialSettings.hideDaaWarning;
  const [daaSplashSeconds, setDaaSplashSeconds] = useState<number>(
    shouldShowDaaSplash ? 3 : 0,
  );

  const [messages, setMessages] = useState<SavedUiMessage[]>([]);
  const [showShortcutsPanel, setShowShortcutsPanel] = useState(false);
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingElapsedMs, setStreamingElapsedMs] = useState(0);
  const streamStartTimeRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [liveThought, setLiveThought] = useState('');
  const [liveText, setLiveText] = useState('');
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(() =>
    isAuthConfigured(initialSettings) ? 'none' : 'auth',
  );
  const [suggestionIdx, setSuggestionIdx] = useState(0);

  // Confirmación de salida con doble Ctrl+C
  const [ctrlCPending, setCtrlCPending] = useState(false);

  // Cola FIFO de prompts en espera, edición con ↑/↓ y confirmación de borrado TUI
  const queueRef = useRef<string[]>([]);
  const [queuedPrompts, setQueuedPrompts] = useState<string[]>([]);
  const [editingQueueIdx, setEditingQueueIdx] = useState<number | null>(null);
  const [confirmDeleteQueueIdx, setConfirmDeleteQueueIdx] = useState<
    number | null
  >(null);
  const originalEditingQueueTextRef = useRef<string>('');
  const draftInputRef = useRef<string>('');

  // Estado del diálogo /auth
  const [authStep, setAuthStep] = useState<
    | 'provider'
    | 'vertex_project'
    | 'vertex_location'
    | 'custom_url'
    | 'custom_key'
    | 'custom_format'
  >('provider');
  const [authChoiceIdx, setAuthChoiceIdx] = useState(0);
  const [authBuffer, setAuthBuffer] = useState('');
  const [tempProject, setTempProject] = useState(
    initialSettings.vertex?.project || process.env['GOOGLE_CLOUD_PROJECT'] || '',
  );
  const [tempUrl, setTempUrl] = useState(
    initialSettings.custom?.baseUrl || 'https://api.openai.com',
  );
  const [tempKey, setTempKey] = useState('');

  // Estado de diálogos /model, /settings, /resume y panel de agentes/chats (←)
  const [dialogCursor, setDialogCursor] = useState(0);
  const [modelPageIdx, setModelPageIdx] = useState(0);
  const [pendingModelForEffort, setPendingModelForEffort] =
    useState<ModelDefinition | null>(null);
  const [modelEffortIdx, setModelEffortIdx] = useState(0);
  const [savedSessionsList, setSavedSessionsList] = useState<SavedSession[]>([]);

  const modelPages = groupModelsByFamilyPages(availableModels);

  const syncSettings = (next: GlitchSettings) => {
    sessionRef.current.settings = next;
    setSettings({ ...next });
    saveSettings(next);
  };

  const persistCurrentSession = (
    nextMessages: SavedUiMessage[],
    currentId = sessionId,
  ) => {
    const history = sessionRef.current.history;
    if (history.length === 0) return;
    const curSettings = sessionRef.current.settings;
    saveSessionToDisk({
      id: currentId,
      title: deriveSessionTitle(nextMessages, history),
      createdAt: sessionCreatedAtRef.current,
      updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      model: curSettings.model,
      effort: curSettings.effort,
      history: [...history],
      messages: nextMessages.filter((m) => m.role !== 'system'),
    });
  };

  const addSystemMessage = (text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, role: 'system', text },
    ]);
  };

  const syncQueueState = () => {
    setQueuedPrompts([...queueRef.current]);
  };

  const refreshModels = async (cfg: GlitchSettings) => {
    if (cfg.provider === 'vertex' && cfg.vertex) {
      try {
        const ai = createVertexGenAI(cfg.vertex);
        const list = await listVertexGoogleModels(ai);
        sessionRef.current.availableModels = list;
        setAvailableModels([...list]);
      } catch {
        sessionRef.current.availableModels = [...LOCAL_GOOGLE_MODELS];
        setAvailableModels([...LOCAL_GOOGLE_MODELS]);
      }
    }
  };

  useEffect(() => {
    if (daaSplashSeconds <= 0) return;
    const timer = setTimeout(() => {
      if (daaSplashSeconds === 1) {
        setDaaSplashSeconds(0);
        addSystemMessage(
          lang === 'en'
            ? '⚠ --DAA flag active: to disable this 3s startup notice, configure it in /settings.'
            : '⚠ Flag --DAA activa: si quieres desactivar este mensaje inicial de 3 segundos, configúralo en /ajustes (Advertencia --DAA al inicio: OFF).',
        );
      } else {
        setDaaSplashSeconds((prev) => prev - 1);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [daaSplashSeconds]);

  // Cronómetro en tiempo real para "Pensando... ("ESC" para cancelar, 1h 30m)"
  useEffect(() => {
    if (!isStreaming) {
      setStreamingElapsedMs(0);
      return;
    }
    const interval = setInterval(() => {
      setStreamingElapsedMs(Date.now() - streamStartTimeRef.current);
    }, 1000);
    return () => clearInterval(interval);
  }, [isStreaming]);

  // Temporizador para limpiar el estado de confirmación de doble Ctrl+C tras 3 segundos
  useEffect(() => {
    if (!ctrlCPending) return;
    const timer = setTimeout(() => {
      setCtrlCPending(false);
    }, 3000);
    return () => clearTimeout(timer);
  }, [ctrlCPending]);

  useEffect(() => {
    if (isAuthConfigured(initialSettings)) {
      void refreshModels(initialSettings);
    }
  }, []);

  const matchingSlash =
    activeDialog === 'none' && confirmDeleteQueueIdx === null
      ? matchSlashCommands(inputText)
      : [];

  const buildAdapter = (): ProviderAdapter => {
    const cur = sessionRef.current.settings;
    if (cur.provider === 'custom' && cur.custom) {
      return new CustomProviderAdapter(cur.custom);
    }
    if (cur.provider === 'vertex' && cur.vertex) {
      const ai = createVertexGenAI(cur.vertex);
      return new VertexProviderAdapter(ai);
    }
    throw new Error('Autenticación no configurada. Usa /auth primero.');
  };

  const runSinglePromptNow = async (userPrompt: string): Promise<void> => {
    const session = sessionRef.current;
    session.isRequestActive = true;
    const startTs = Date.now();
    streamStartTimeRef.current = startTs;
    setStreamingElapsedMs(0);
    setIsStreaming(true);
    setLiveThought('');
    setLiveText('');

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const userMsg: SavedUiMessage = {
      id: `${Date.now()}-${Math.random()}-u`,
      role: 'user',
      text: userPrompt,
      timestamp: formatMessageTimestamp(new Date()),
    };
    setMessages((prev) => [...prev, userMsg]);
    session.history.push({ role: 'user', parts: [{ text: userPrompt }] });

    try {
      const live = session.getLiveCallConfig();
      const adapter = buildAdapter();
      const collectedParts: Part[] = [];
      let accText = '';
      let accThought = '';

      for await (const chunk of adapter.streamTurn(session.history, {
        model: live.model,
        effort: live.effort,
        includeThoughts: live.includeThoughts,
        subMode: live.subMode,
        abortSignal: abortController.signal,
      })) {
        if (abortController.signal.aborted) {
          break;
        }
        if (chunk.rawParts && chunk.rawParts.length > 0) {
          collectedParts.push(...chunk.rawParts);
        }
        if (chunk.thoughtText) {
          accThought += chunk.thoughtText;
          setLiveThought(accThought);
        }
        if (chunk.text) {
          accText += chunk.text;
          setLiveText(accText);
        }
      }

      const elapsed = formatElapsedDuration(Date.now() - startTs);

      if (abortController.signal.aborted) {
        const cancelNote =
          lang === 'en' ? '[Cancelled with ESC]' : '[Cancelado con ESC]';
        const finalText = accText ? `${accText} ${cancelNote}` : cancelNote;
        session.history.push({
          role: 'model',
          parts: [{ text: finalText }],
        });
        const cancelledMsg: SavedUiMessage = {
          id: `${Date.now()}-${Math.random()}-m`,
          role: 'model',
          text: finalText,
          thoughtText: accThought || undefined,
          durationText: elapsed,
        };
        setMessages((prev) => {
          const next = [...prev, cancelledMsg];
          persistCurrentSession(next);
          return next;
        });
        return;
      }

      session.history.push({
        role: 'model',
        parts:
          collectedParts.length > 0
            ? collectedParts
            : [{ text: accText }],
      });

      const modelMsg: SavedUiMessage = {
        id: `${Date.now()}-${Math.random()}-m`,
        role: 'model',
        text: accText || '(sin respuesta de texto)',
        thoughtText: accThought || undefined,
        durationText: elapsed,
      };
      setMessages((prev) => {
        const next = [...prev, modelMsg];
        persistCurrentSession(next);
        return next;
      });
    } catch (err) {
      if (abortController.signal.aborted) {
        addSystemMessage(
          lang === 'en'
            ? '⚠ Request cancelled by user (ESC).'
            : '⚠ Petición cancelada por el usuario (ESC).',
        );
      } else {
        addSystemMessage(formatCleanApiError(err));
      }
    } finally {
      abortControllerRef.current = null;
    }
  };

  const startOrEnqueuePrompt = (userPrompt: string) => {
    const session = sessionRef.current;

    if (session.isRequestActive) {
      queueRef.current.push(userPrompt);
      syncQueueState();
      return;
    }

    void (async () => {
      await runSinglePromptNow(userPrompt);
      while (queueRef.current.length > 0) {
        const nextPrompt = queueRef.current.shift()!;
        setEditingQueueIdx((currIdx) => {
          if (currIdx === null) return null;
          return currIdx > 0 ? currIdx - 1 : null;
        });
        syncQueueState();
        await runSinglePromptNow(nextPrompt);
      }
      session.isRequestActive = false;
      setIsStreaming(false);
      setLiveThought('');
      setLiveText('');
    })();
  };

  const openAgentsAndChatsDrawer = () => {
    persistCurrentSession(messages);
    const saved = listSavedSessions();
    setSavedSessionsList(saved);
    setDialogCursor(0);
    setActiveDialog('agents_chats');
  };

  const executeInputCommand = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    const resolved = trimmed.startsWith('/')
      ? resolveSlashCommandAlias(trimmed)
      : trimmed;

    if (resolved === '/exit') {
      persistCurrentSession(messages);
      exit();
      return;
    }

    if (resolved === '/help' || resolved === '?') {
      setShowShortcutsPanel((prev) => !prev);
      return;
    }

    if (resolved === '/new') {
      persistCurrentSession(messages);
      sessionRef.current.history.length = 0;
      const nextId = createSessionId();
      sessionCreatedAtRef.current = new Date().toISOString();
      setSessionId(nextId);
      setMessages([]);
      setShowShortcutsPanel(false);
      return;
    }

    if (resolved === '/resume' || resolved.startsWith('/resume ')) {
      const arg = resolved.slice('/resume'.length).trim();
      persistCurrentSession(messages);
      const list = listSavedSessions();
      if (list.length === 0) {
        addSystemMessage(
          lang === 'en'
            ? 'ℹ No saved conversations yet to resume.'
            : 'ℹ No hay conversaciones guardadas todavía para retomar.',
        );
        return;
      }
      if (arg) {
        const byIdx = Number.parseInt(arg, 10);
        const found =
          !Number.isNaN(byIdx) && byIdx >= 1 && byIdx <= list.length
            ? list[byIdx - 1]
            : list.find((s) => s.id === arg);
        if (!found) {
          addSystemMessage(`✗ No se encontró la conversación "${arg}".`);
          return;
        }
        sessionRef.current.history.length = 0;
        sessionRef.current.history.push(...found.history);
        setSessionId(found.id);
        sessionCreatedAtRef.current = found.createdAt;
        setMessages([
          ...found.messages,
          {
            id: `${Date.now()}-resumed`,
            role: 'system',
            text: `✓ Conversación retomada: "${found.title}" (${found.history.length} turnos).`,
          },
        ]);
        return;
      }
      setSavedSessionsList(list);
      setDialogCursor(0);
      setActiveDialog('resume');
      return;
    }

    if (resolved === '/auth') {
      setAuthStep('provider');
      setAuthChoiceIdx(0);
      setAuthBuffer('');
      setActiveDialog('auth');
      return;
    }

    if (resolved === '/settings') {
      setDialogCursor(0);
      setActiveDialog('settings');
      return;
    }

    if (resolved === '/model' || resolved.startsWith('/model ')) {
      if (sessionRef.current.isRequestActive) {
        addSystemMessage(
          lang === 'en'
            ? '⚠ Cannot switch model while a request is active. Wait for the current task to finish.'
            : '⚠ No puedes cambiar de modelo mientras hay una petición activa. Espera a que termine la tarea actual.',
        );
        return;
      }
      const rawArgs = resolved.slice('/model'.length).trim();
      if (rawArgs) {
        const { modelArg, effortArg } = parseModelAndEffortArgs(rawArgs);
        const exists = availableModels.find((m) => m.id === modelArg);
        if (!exists && (settings.provider ?? 'vertex') === 'vertex') {
          addSystemMessage(`✗ Modelo "${modelArg}" no disponible en Vertex AI.`);
          return;
        }
        const def = getModelDefinition(modelArg, settings.provider ?? 'vertex');
        let nextEffort = settings.effort;

        if (effortArg) {
          if (def.supportedEfforts.length === 0) {
            addSystemMessage(
              `⚠ ${def.name} no usa niveles de esfuerzo (ESFUERZO: N/A). Se activó el modelo sin effort.`,
            );
          } else if (
            !def.supportedEfforts.includes(effortArg as EffortLevel)
          ) {
            addSystemMessage(
              `✗ El esfuerzo "${effortArg}" no es válido para ${def.name}. Permitidos: ${def.supportedEfforts.map((e) => e.toUpperCase()).join(' - ')}.`,
            );
            return;
          } else {
            nextEffort = effortArg as EffortLevel;
          }
        } else if (
          def.supportedEfforts.length > 0 &&
          !def.supportedEfforts.includes(nextEffort)
        ) {
          nextEffort = def.defaultEffort ?? def.supportedEfforts[0]!;
        }

        const updated: GlitchSettings = {
          ...settings,
          model: def.id,
          effort: nextEffort,
        };
        syncSettings(updated);
        addSystemMessage(
          `✓ Modelo cambiado a ${def.name} (${updated.model})${def.supportedEfforts.length > 0 ? ` con Esfuerzo: ${updated.effort.toUpperCase()}` : ''}.`,
        );
        return;
      }

      const foundPageIdx = Math.max(
        0,
        modelPages.findIndex((p) =>
          p.models.some((m) => m.id === settings.model),
        ),
      );
      const pageModels = modelPages[foundPageIdx]?.models ?? [];
      const currentIdx = Math.max(
        0,
        pageModels.findIndex((m) => m.id === settings.model),
      );
      setPendingModelForEffort(null);
      setModelPageIdx(foundPageIdx);
      setDialogCursor(currentIdx);
      setActiveDialog('model');
      return;
    }

    if (resolved === '/effort' || resolved.startsWith('/effort ')) {
      const arg = resolved.slice('/effort'.length).trim();
      const logs: string[] = [];
      const updated = runEffortCommand(
        sessionRef.current.settings,
        arg,
        (m) => logs.push(m),
      );
      syncSettings(updated);
      if (logs.length > 0) {
        addSystemMessage(logs.join(os.EOL));
      }
      return;
    }

    if (resolved.startsWith('/')) {
      addSystemMessage(
        lang === 'en'
          ? `✗ Unknown command: ${trimmed}. Type /help to see available commands.`
          : `✗ Comando desconocido: ${trimmed}. Usa /ayuda para ver los comandos disponibles.`,
      );
      return;
    }

    if (!isAuthConfigured(sessionRef.current.settings)) {
      addSystemMessage('⚠ Configura primero tu conexión con /auth.');
      setActiveDialog('auth');
      return;
    }

    startOrEnqueuePrompt(trimmed);
  };

  useInput((input, key) => {
    // Doble Ctrl+C para salir de Glitch CLI
    if (key.ctrl && input.toLowerCase() === 'c') {
      if (ctrlCPending) {
        persistCurrentSession(messages);
        exit();
      } else {
        setCtrlCPending(true);
      }
      return;
    }

    if (daaSplashSeconds > 0) {
      return;
    }

    // Confirmación TUI cuando el usuario borra por completo un prompt de la fila de espera: "¿Borrar posición #N?"
    if (confirmDeleteQueueIdx !== null) {
      const lower = input.toLowerCase();
      if (key.return || lower === 's' || lower === 'y') {
        queueRef.current.splice(confirmDeleteQueueIdx, 1);
        syncQueueState();
        setConfirmDeleteQueueIdx(null);
        setEditingQueueIdx(null);
        setInputText(draftInputRef.current);
        draftInputRef.current = '';
        return;
      }
      if (key.escape || lower === 'n') {
        const restored = originalEditingQueueTextRef.current;
        setConfirmDeleteQueueIdx(null);
        setInputText(restored);
        return;
      }
      return;
    }

    // ESC durante respuesta en streaming: cancela la petición actual
    if (
      key.escape &&
      isStreaming &&
      activeDialog === 'none' &&
      editingQueueIdx === null
    ) {
      abortControllerRef.current?.abort();
      return;
    }

    // Atajo global en vivo: Shift+Tab o Alt+P alterna Sub-Modo Plan <-> Agente/Agent
    if ((key.tab && key.shift) || (key.meta && input.toLowerCase() === 'p')) {
      const nextSubMode: SubMode = toggleSubMode(
        sessionRef.current.settings.subMode,
      );
      const updated: GlitchSettings = {
        ...sessionRef.current.settings,
        subMode: nextSubMode,
      };
      syncSettings(updated);
      return;
    }

    // Tecla ← (flecha izquierda) o '<' en el chat normal con barra vacía: abre Agentes y Chats en tiempo real + Historial
    if (
      activeDialog === 'none' &&
      editingQueueIdx === null &&
      inputText.length === 0 &&
      (key.leftArrow || input === '<')
    ) {
      openAgentsAndChatsDrawer();
      return;
    }

    // Atajo '?' instantáneo cuando la barra de entrada está vacía y no hay diálogo abierto
    if (
      activeDialog === 'none' &&
      inputText.length === 0 &&
      input === '?' &&
      !key.ctrl &&
      !key.meta
    ) {
      setShowShortcutsPanel((prev) => !prev);
      return;
    }

    // Manejo del panel de Agentes y Chats en tiempo real + Historial (abierto con ←)
    if (activeDialog === 'agents_chats') {
      const totalEntries = 1 + savedSessionsList.length; // 0 = Agente/Chat actual en vivo, 1..N = historial guardado
      if (key.escape || key.rightArrow) {
        setActiveDialog('none');
        return;
      }
      if (key.upArrow && totalEntries > 0) {
        setDialogCursor((prev) => (prev > 0 ? prev - 1 : totalEntries - 1));
        return;
      }
      if (key.downArrow && totalEntries > 0) {
        setDialogCursor((prev) => (prev < totalEntries - 1 ? prev + 1 : 0));
        return;
      }
      if (key.return) {
        if (dialogCursor === 0) {
          // Seguir en el agente/chat actual
          setActiveDialog('none');
          return;
        }
        const picked = savedSessionsList[dialogCursor - 1];
        if (picked) {
          sessionRef.current.history.length = 0;
          sessionRef.current.history.push(...picked.history);
          setSessionId(picked.id);
          sessionCreatedAtRef.current = picked.createdAt;
          setMessages([
            ...picked.messages,
            {
              id: `${Date.now()}-resumed`,
              role: 'system',
              text:
                lang === 'en'
                  ? `✓ Switched to chat: "${picked.title}" (${picked.history.length} turns).`
                  : `✓ Cambiado al chat: "${picked.title}" (${picked.history.length} turnos).`,
            },
          ]);
        }
        setActiveDialog('none');
        return;
      }
      return;
    }

    // Manejo del diálogo /resume
    if (activeDialog === 'resume') {
      if (key.escape) {
        setActiveDialog('none');
        return;
      }
      if (key.upArrow && savedSessionsList.length > 0) {
        setDialogCursor((prev) =>
          prev > 0 ? prev - 1 : savedSessionsList.length - 1,
        );
        return;
      }
      if (key.downArrow && savedSessionsList.length > 0) {
        setDialogCursor((prev) =>
          prev < savedSessionsList.length - 1 ? prev + 1 : 0,
        );
        return;
      }
      if (key.return) {
        const picked = savedSessionsList[dialogCursor];
        if (picked) {
          sessionRef.current.history.length = 0;
          sessionRef.current.history.push(...picked.history);
          setSessionId(picked.id);
          sessionCreatedAtRef.current = picked.createdAt;
          setMessages([
            ...picked.messages,
            {
              id: `${Date.now()}-resumed`,
              role: 'system',
              text: `✓ Conversación retomada: "${picked.title}" (${picked.history.length} turnos).`,
            },
          ]);
        }
        setActiveDialog('none');
        return;
      }
      return;
    }

    // Manejo del diálogo /auth
    if (activeDialog === 'auth') {
      if (key.escape && isAuthConfigured(settings)) {
        setActiveDialog('none');
        return;
      }

      if (authStep === 'provider') {
        if (key.upArrow || key.downArrow) {
          setAuthChoiceIdx((prev) => (prev === 0 ? 1 : 0));
          return;
        }
        if (key.return) {
          if (authChoiceIdx === 0) {
            setAuthBuffer(
              settings.vertex?.project ||
                process.env['GOOGLE_CLOUD_PROJECT'] ||
                '',
            );
            setAuthStep('vertex_project');
          } else {
            setAuthBuffer(
              settings.custom?.baseUrl || 'https://api.openai.com',
            );
            setAuthStep('custom_url');
          }
          return;
        }
        return;
      }

      if (authStep === 'custom_format') {
        if (key.upArrow || key.downArrow) {
          setAuthChoiceIdx((prev) => (prev === 0 ? 1 : 0));
          return;
        }
        if (key.return) {
          const format: CustomEndpointFormat =
            authChoiceIdx === 1 ? 'responses' : 'chat_completions';
          const updated: GlitchSettings = {
            ...settings,
            provider: 'custom',
            custom: {
              baseUrl: tempUrl,
              apiKey: tempKey,
              format,
            },
          };
          syncSettings(updated);
          setActiveDialog('none');
          addSystemMessage(
            `✓ API personalizada conectada (${tempUrl}, formato: ${format}, key: ${maskApiKey(tempKey)}).`,
          );
          return;
        }
        return;
      }

      if (key.return) {
        const val = authBuffer.trim();
        if (authStep === 'vertex_project') {
          if (!val) return;
          setTempProject(val);
          setAuthBuffer(
            settings.vertex?.location ||
              process.env['GOOGLE_CLOUD_LOCATION'] ||
              'us-central1',
          );
          setAuthStep('vertex_location');
          return;
        }
        if (authStep === 'vertex_location') {
          const loc = val || 'us-central1';
          const updated: GlitchSettings = {
            ...settings,
            provider: 'vertex',
            vertex: { project: tempProject, location: loc },
          };
          process.env['GOOGLE_CLOUD_PROJECT'] = tempProject;
          process.env['GOOGLE_CLOUD_LOCATION'] = loc;
          syncSettings(updated);
          setActiveDialog('none');
          addSystemMessage(
            `✓ Conectado a Vertex AI (proyecto: ${tempProject}, región: ${loc}) usando ADC.`,
          );
          void refreshModels(updated);
          return;
        }
        if (authStep === 'custom_url') {
          if (!val) return;
          setTempUrl(val);
          setAuthBuffer('');
          setAuthStep('custom_key');
          return;
        }
        if (authStep === 'custom_key') {
          const finalKey = val || settings.custom?.apiKey || '';
          if (!finalKey) return;
          setTempKey(finalKey);
          setAuthChoiceIdx(0);
          setAuthStep('custom_format');
          return;
        }
        return;
      }

      if (key.backspace || key.delete) {
        setAuthBuffer((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setAuthBuffer((prev) => prev + input);
      }
      return;
    }

    // Manejo del diálogo /model (con paginación ← / → y selección de esfuerzo integrada)
    if (activeDialog === 'model') {
      if (pendingModelForEffort) {
        const efforts = pendingModelForEffort.supportedEfforts;
        if (key.escape) {
          setPendingModelForEffort(null);
          return;
        }
        if (key.leftArrow || key.upArrow) {
          setModelEffortIdx((prev) =>
            prev > 0 ? prev - 1 : efforts.length - 1,
          );
          return;
        }
        if (key.rightArrow || key.downArrow) {
          setModelEffortIdx((prev) =>
            prev < efforts.length - 1 ? prev + 1 : 0,
          );
          return;
        }
        if (key.return) {
          const chosenEffort =
            efforts[modelEffortIdx] ??
            pendingModelForEffort.defaultEffort ??
            efforts[0]!;
          const updated: GlitchSettings = {
            ...settings,
            model: pendingModelForEffort.id,
            effort: chosenEffort,
          };
          syncSettings(updated);
          addSystemMessage(
            `✓ Modelo seleccionado: ${pendingModelForEffort.name} | ${pendingModelForEffort.id} (Esfuerzo: ${chosenEffort.toUpperCase()})`,
          );
          setPendingModelForEffort(null);
          setActiveDialog('none');
          return;
        }
        return;
      }

      const currentPage = modelPages[modelPageIdx] ?? modelPages[0];
      const pageModels = currentPage?.models ?? [];

      if (key.escape) {
        setActiveDialog('none');
        return;
      }
      if (key.leftArrow && modelPages.length > 0) {
        setModelPageIdx((prev) =>
          prev > 0 ? prev - 1 : modelPages.length - 1,
        );
        setDialogCursor(0);
        return;
      }
      if (key.rightArrow && modelPages.length > 0) {
        setModelPageIdx((prev) =>
          prev < modelPages.length - 1 ? prev + 1 : 0,
        );
        setDialogCursor(0);
        return;
      }
      if (key.upArrow && pageModels.length > 0) {
        setDialogCursor((prev) =>
          prev > 0 ? prev - 1 : pageModels.length - 1,
        );
        return;
      }
      if (key.downArrow && pageModels.length > 0) {
        setDialogCursor((prev) =>
          prev < pageModels.length - 1 ? prev + 1 : 0,
        );
        return;
      }
      if (key.return) {
        if (sessionRef.current.isRequestActive) {
          addSystemMessage(
            '⚠ No puedes cambiar de modelo mientras hay una petición activa.',
          );
          setActiveDialog('none');
          return;
        }
        const picked = pageModels[dialogCursor];
        if (picked) {
          if (picked.supportedEfforts.length > 1) {
            const defaultEffort =
              picked.supportedEfforts.includes(settings.effort)
                ? settings.effort
                : (picked.defaultEffort ?? picked.supportedEfforts[0]!);
            const effIdx = Math.max(
              0,
              picked.supportedEfforts.indexOf(defaultEffort),
            );
            setModelEffortIdx(effIdx);
            setPendingModelForEffort(picked);
            return;
          }

          const nextEffort =
            picked.supportedEfforts.length === 1
              ? picked.supportedEfforts[0]!
              : settings.effort;
          const updated: GlitchSettings = {
            ...settings,
            model: picked.id,
            effort: nextEffort,
          };
          syncSettings(updated);
          addSystemMessage(
            `✓ Modelo seleccionado: ${picked.name} | ${picked.id} (${picked.supportedEfforts.length > 0 ? `Esfuerzo: ${updated.effort.toUpperCase()}` : 'Esfuerzo: N/A'})`,
          );
        }
        setActiveDialog('none');
        return;
      }
      return;
    }

    // Manejo del diálogo /settings (/ajustes) — 6 opciones incluyendo Idioma
    if (activeDialog === 'settings') {
      if (key.escape) {
        setActiveDialog('none');
        return;
      }
      if (key.upArrow) {
        setDialogCursor((prev) => (prev > 0 ? prev - 1 : 5));
        return;
      }
      if (key.downArrow) {
        setDialogCursor((prev) => (prev < 5 ? prev + 1 : 0));
        return;
      }
      if (key.return || key.leftArrow || key.rightArrow) {
        const cur = sessionRef.current.settings;
        if (dialogCursor === 0) {
          const order: PermissionMode[] = [
            'always_allow',
            'ask_insecure',
            'always_ask',
          ];
          const nextMode =
            order[(order.indexOf(cur.permissionMode) + 1) % order.length]!;
          syncSettings({ ...cur, permissionMode: nextMode });
        } else if (dialogCursor === 1) {
          syncSettings({ ...cur, subMode: toggleSubMode(cur.subMode) });
        } else if (dialogCursor === 2) {
          const order: EffortLevel[] = ['low', 'medium', 'high'];
          const nextEffort =
            order[(order.indexOf(cur.effort) + 1) % order.length]!;
          syncSettings({ ...cur, effort: nextEffort });
        } else if (dialogCursor === 3) {
          syncSettings({ ...cur, thoughts: !cur.thoughts });
        } else if (dialogCursor === 4) {
          syncSettings({ ...cur, hideDaaWarning: !cur.hideDaaWarning });
        } else if (dialogCursor === 5) {
          const nextLang: AppLanguage =
            (cur.language ?? 'es') === 'es' ? 'en' : 'es';
          syncSettings({ ...cur, language: nextLang });
        }
        return;
      }
      return;
    }

    // Autocompletado de Slash Commands (muestra comandos en el idioma activo)
    if (matchingSlash.length > 0) {
      if (key.upArrow) {
        setSuggestionIdx((prev) =>
          prev > 0 ? prev - 1 : matchingSlash.length - 1,
        );
        return;
      }
      if (key.downArrow) {
        setSuggestionIdx((prev) =>
          prev < matchingSlash.length - 1 ? prev + 1 : 0,
        );
        return;
      }
      if (key.tab) {
        const chosen = matchingSlash[suggestionIdx] ?? matchingSlash[0];
        if (chosen) {
          setInputText(chosen.displayCmd[lang] + ' ');
          setSuggestionIdx(0);
        }
        return;
      }
    }

    // Navegación con ↑ / ↓ sobre la fila de prompts en cola (Queue)
    if (matchingSlash.length === 0 && queueRef.current.length > 0) {
      if (key.upArrow) {
        const q = queueRef.current;
        if (editingQueueIdx === null) {
          draftInputRef.current = inputText;
          const targetIdx = q.length - 1;
          originalEditingQueueTextRef.current = q[targetIdx] ?? '';
          setEditingQueueIdx(targetIdx);
          setInputText(q[targetIdx] ?? '');
        } else if (editingQueueIdx > 0) {
          const targetIdx = editingQueueIdx - 1;
          originalEditingQueueTextRef.current = q[targetIdx] ?? '';
          setEditingQueueIdx(targetIdx);
          setInputText(q[targetIdx] ?? '');
        }
        return;
      }
      if (key.downArrow && editingQueueIdx !== null) {
        const q = queueRef.current;
        if (editingQueueIdx < q.length - 1) {
          const targetIdx = editingQueueIdx + 1;
          originalEditingQueueTextRef.current = q[targetIdx] ?? '';
          setEditingQueueIdx(targetIdx);
          setInputText(q[targetIdx] ?? '');
        } else {
          setEditingQueueIdx(null);
          setInputText(draftInputRef.current);
        }
        return;
      }
      if (key.escape && editingQueueIdx !== null) {
        setEditingQueueIdx(null);
        setInputText(draftInputRef.current);
        return;
      }
    }

    if (key.return) {
      if (
        editingQueueIdx !== null &&
        editingQueueIdx >= 0 &&
        editingQueueIdx < queueRef.current.length &&
        !inputText.trim().startsWith('/')
      ) {
        const replacement = inputText.trim();
        if (!replacement) {
          setConfirmDeleteQueueIdx(editingQueueIdx);
          return;
        }
        queueRef.current[editingQueueIdx] = replacement;
        syncQueueState();
        setEditingQueueIdx(null);
        setInputText(draftInputRef.current);
        draftInputRef.current = '';
        return;
      }

      if (
        matchingSlash.length > 0 &&
        !inputText.trim().includes(' ') &&
        inputText.trim() !== matchingSlash[suggestionIdx]?.displayCmd[lang] &&
        !SLASH_COMMANDS.some(
          (s) =>
            s.cmd === inputText.trim() ||
            s.displayCmd[lang] === inputText.trim(),
        )
      ) {
        const chosen = matchingSlash[suggestionIdx];
        if (chosen) {
          setInputText('');
          setSuggestionIdx(0);
          executeInputCommand(chosen.cmd);
          return;
        }
      }
      const toRun = inputText;
      setInputText('');
      setEditingQueueIdx(null);
      setSuggestionIdx(0);
      executeInputCommand(toRun);
      return;
    }

    if (key.backspace || key.delete) {
      if (editingQueueIdx !== null && inputText.length <= 1) {
        setInputText('');
        setConfirmDeleteQueueIdx(editingQueueIdx);
        return;
      }
      setInputText((prev) => prev.slice(0, -1));
      setSuggestionIdx(0);
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setInputText((prev) => prev + input);
      setSuggestionIdx(0);
    }
  });

  if (daaSplashSeconds > 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="double"
        borderColor="red"
        paddingX={3}
        paddingY={1}
        margin={1}
      >
        <Text bold color="red">
          ⚠ ADVERTENCIA DE SEGURIDAD: FLAG --DAA (--dangerously-always-allow) DETECTADA
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">
            • Has iniciado Glitch CLI con --DAA: modo Always Allow y SIN SANDBOX.
          </Text>
          <Text color="yellow">
            • Tiene acceso completo a todo tu PC sin importar desde qué carpeta lo abras (Downloads, System32, etc.).
          </Text>
          <Text color="yellow">
            • Ninguna acción o modificación pedirá confirmación manual mientras este modo esté activo.
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color="white" bold>
            Iniciando Glitch CLI en {daaSplashSeconds} segundos...
          </Text>
        </Box>
        <Text color="gray">
          (Puedes desactivar esta advertencia inicial en /ajustes → Advertencia --DAA al inicio: OFF)
        </Text>
      </Box>
    );
  }

  const artWidth = GLITCH_ASCII_LINES[0]?.length ?? 80;
  const artPad = ' '.repeat(Math.max(0, Math.floor((columns - artWidth) / 2)));

  let userTurnCounter = 0;
  let modelTurnCounter = 0;
  const numberedMessages = messages.map((m) => {
    if (m.role === 'user') {
      userTurnCounter++;
      return { ...m, turnNumber: userTurnCounter };
    }
    if (m.role === 'model') {
      modelTurnCounter++;
      return { ...m, turnNumber: modelTurnCounter };
    }
    return { ...m, turnNumber: 0 };
  });
  const nextStreamingReplyNumber = modelTurnCounter + 1;

  const modeColor =
    settings.permissionMode === 'always_allow'
      ? 'redBright'
      : settings.permissionMode === 'ask_insecure'
        ? 'yellow'
        : 'cyan';

  const msgPrefixLabel = lang === 'en' ? 'Message' : 'Mensaje';
  const replyPrefixLabel = lang === 'en' ? 'Reply' : 'Respuesta';

  return (
    <Box
      flexDirection="column"
      minHeight={Math.max(22, rows - 1)}
      justifyContent="space-between"
      paddingX={1}
    >
      {/* ZONA SUPERIOR: Cabecera + Respuestas del Modelo + Diálogos */}
      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="column">
              <Box>
                <Text bold color="white">
                  {'>_ Glitch CLI '}
                </Text>
                <Text color="gray">(v{version})</Text>
              </Box>
              <Text color="gray">   {formatShortCwd()}</Text>
            </Box>
            <Box>
              <Text color="cyan">{IGLITCHOFF_WORDMARK}</Text>
            </Box>
          </Box>

          {messages.length === 0 && activeDialog === 'none' && (
            <Box flexDirection="column" marginTop={1}>
              {GLITCH_ASCII_LINES.map((line, i) => (
                <Text key={i} color="gray">
                  {artPad}
                  {line}
                </Text>
              ))}
            </Box>
          )}
        </Box>

        {/* Historial numerado: Mensaje 1 (10/25/2026 8:41 PM) > ... y Respuesta 1 · 12s > ... */}
        {numberedMessages.map((m) => (
          <Box key={m.id} flexDirection="column" marginBottom={1}>
            {m.role === 'user' && (
              <Box>
                <Text color="cyan" bold>
                  {`${msgPrefixLabel} ${m.turnNumber}${m.timestamp ? ` (${m.timestamp})` : ''} > `}
                </Text>
                <Text color="white" bold>
                  {m.text}
                </Text>
              </Box>
            )}
            {m.role === 'model' && (
              <Box flexDirection="column">
                {m.thoughtText && settings.thoughts && (
                  <Box
                    borderStyle="single"
                    borderColor="gray"
                    paddingX={1}
                    marginBottom={1}
                  >
                    <Text color="gray" italic>
                      💭 {m.thoughtText}
                    </Text>
                  </Box>
                )}
                <Box>
                  <Text color="green" bold>
                    {`${replyPrefixLabel} ${m.turnNumber}${m.durationText ? ` · ${m.durationText}` : ''} > `}
                  </Text>
                  <Text color="white">{m.text}</Text>
                </Box>
              </Box>
            )}
            {m.role === 'system' && (
              <Box>
                <Text color="yellow">{m.text}</Text>
              </Box>
            )}
          </Box>
        ))}

        {/* Respuesta en vivo numerada (Streaming): Pensando... ("ESC" para cancelar, 1h 30m) */}
        {isStreaming && (
          <Box flexDirection="column" marginBottom={1}>
            <Text color="cyan" bold>
              {lang === 'en'
                ? `Thinking... ("ESC" to cancel, ${formatElapsedDuration(streamingElapsedMs)})`
                : `Pensando... ("ESC" para cancelar, ${formatElapsedDuration(streamingElapsedMs)})`}
            </Text>
            {liveThought && settings.thoughts && (
              <Box borderStyle="single" borderColor="gray" paddingX={1}>
                <Text color="gray" italic>
                  💭 {liveThought}
                </Text>
              </Box>
            )}
            {liveText && (
              <Box>
                <Text color="green" bold>
                  {`${replyPrefixLabel} ${nextStreamingReplyNumber} · ${formatElapsedDuration(streamingElapsedMs)} > `}
                </Text>
                <Text color="white">{liveText}</Text>
              </Box>
            )}
          </Box>
        )}

        {/* Panel de Agentes y Chats en tiempo real + Historial (abierto con la flecha ← en chat vacío) */}
        {activeDialog === 'agents_chats' && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={2}
            paddingY={1}
            marginBottom={1}
          >
            <Box
              flexDirection="row"
              justifyContent="space-between"
              marginBottom={1}
            >
              <Text bold color="cyan">
                {lang === 'en'
                  ? '◄ Live Agents, Active Chats & History'
                  : '◄ Agentes y Chats en Tiempo Real + Historial'}
              </Text>
              <Text color="gray">
                {lang === 'en'
                  ? '↑/↓ select · Enter open · → or Esc back'
                  : '↑/↓ elegir · Enter abrir · → o Esc volver'}
              </Text>
            </Box>

            <Text bold color="green">
              {lang === 'en'
                ? 'Active Agent / Current Session (Real-Time):'
                : 'Agente / Sesión Activa en Tiempo Real:'}
            </Text>
            <Text color={dialogCursor === 0 ? 'cyan' : 'white'} bold={dialogCursor === 0}>
              {dialogCursor === 0 ? '❯ ' : '  '}
              {isStreaming
                ? lang === 'en'
                  ? '🟢 [RUNNING]'
                  : '🟢 [PENSANDO EN VIVO]'
                : lang === 'en'
                  ? '🟢 [ACTIVE]'
                  : '🟢 [ACTIVO]'}{' '}
              {deriveSessionTitle(messages, sessionRef.current.history).padEnd(
                36,
                ' ',
              )}{' '}
              | {settings.model} ({settings.effort.toUpperCase()}) |{' '}
              {formatSubModeLabel(settings.subMode, lang)} |{' '}
              {sessionRef.current.history.length}{' '}
              {lang === 'en' ? 'turns' : 'turnos'}
            </Text>

            <Box marginTop={1} flexDirection="column">
              <Text bold color="yellow">
                {lang === 'en'
                  ? `Chat History (${savedSessionsList.length}):`
                  : `Historial de Chats Guardados (${savedSessionsList.length}):`}
              </Text>
              {savedSessionsList.length === 0 ? (
                <Text color="gray">
                  {lang === 'en'
                    ? '  (No saved conversations yet)'
                    : '  (Aún no hay conversaciones anteriores guardadas)'}
                </Text>
              ) : (
                savedSessionsList.map((s, idx) => {
                  const rowIndex = idx + 1;
                  const isSelected = dialogCursor === rowIndex;
                  const isCurrentId = s.id === sessionId;
                  return (
                    <Text
                      key={s.id}
                      color={isSelected ? 'cyan' : 'white'}
                      bold={isSelected}
                    >
                      {isSelected ? '❯ ' : '  '}
                      {s.title.padEnd(42, ' ')} | {s.model.padEnd(24, ' ')} |{' '}
                      {s.updatedAt} ({s.history.length}{' '}
                      {lang === 'en' ? 'turns' : 'turnos'})
                      {isCurrentId ? ' (actual)' : ''}
                    </Text>
                  );
                })
              )}
            </Box>
          </Box>
        )}

        {/* Diálogo interactivo /resume */}
        {activeDialog === 'resume' && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={2}
            paddingY={1}
            marginBottom={1}
          >
            <Text bold color="cyan">
              Retomar Conversación (/resume) — ↑/↓ para elegir, Enter cargar, Esc salir
            </Text>
            {savedSessionsList.map((s, idx) => {
              const isSelected = idx === dialogCursor;
              return (
                <Text key={s.id} color={isSelected ? 'cyan' : 'white'}>
                  {isSelected ? '❯ ' : '  '}
                  {s.title.padEnd(48, ' ')} | {s.model.padEnd(24, ' ')} |{' '}
                  {s.updatedAt} ({s.history.length} turnos)
                </Text>
              );
            })}
          </Box>
        )}

        {/* Diálogo interactivo /auth */}
        {activeDialog === 'auth' && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={2}
            paddingY={1}
            marginBottom={1}
          >
            <Text bold color="cyan">
              Configuración de Autenticación (/auth)
            </Text>
            <Text color="gray">Actual: {formatAuthSummary(settings)}</Text>
            {authStep === 'provider' && (
              <Box flexDirection="column" marginTop={1}>
                <Text>Selecciona proveedor (↑/↓ y Enter):</Text>
                <Text color={authChoiceIdx === 0 ? 'cyan' : 'white'}>
                  {authChoiceIdx === 0 ? '❯ ' : '  '}1. Vertex AI (Application Default Credentials - Free Trial)
                </Text>
                <Text color={authChoiceIdx === 1 ? 'cyan' : 'white'}>
                  {authChoiceIdx === 1 ? '❯ ' : '  '}2. API personalizada (/v1/chat/completions o /v1/responses)
                </Text>
              </Box>
            )}
            {authStep === 'vertex_project' && (
              <Box flexDirection="column" marginTop={1}>
                <Text>Proyecto GCP (GOOGLE_CLOUD_PROJECT):</Text>
                <Text color="cyan">
                  {'› '}
                  {authBuffer}█
                </Text>
              </Box>
            )}
            {authStep === 'vertex_location' && (
              <Box flexDirection="column" marginTop={1}>
                <Text>Región GCP (GOOGLE_CLOUD_LOCATION):</Text>
                <Text color="cyan">
                  {'› '}
                  {authBuffer}█
                </Text>
              </Box>
            )}
            {authStep === 'custom_url' && (
              <Box flexDirection="column" marginTop={1}>
                <Text>Base URL del proveedor personalizado:</Text>
                <Text color="cyan">
                  {'› '}
                  {authBuffer}█
                </Text>
              </Box>
            )}
            {authStep === 'custom_key' && (
              <Box flexDirection="column" marginTop={1}>
                <Text>API Key (se mostrará y guardará enmascarada):</Text>
                <Text color="cyan">
                  {'› '}
                  {authBuffer ? '*'.repeat(Math.min(authBuffer.length, 24)) : ''}█
                </Text>
              </Box>
            )}
            {authStep === 'custom_format' && (
              <Box flexDirection="column" marginTop={1}>
                <Text>Selecciona el formato del endpoint (↑/↓ y Enter):</Text>
                <Text color={authChoiceIdx === 0 ? 'cyan' : 'white'}>
                  {authChoiceIdx === 0 ? '❯ ' : '  '}1. /v1/chat/completions
                </Text>
                <Text color={authChoiceIdx === 1 ? 'cyan' : 'white'}>
                  {authChoiceIdx === 1 ? '❯ ' : '  '}2. /v1/responses
                </Text>
              </Box>
            )}
          </Box>
        )}

        {/* Diálogo interactivo /model */}
        {activeDialog === 'model' && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={2}
            paddingY={1}
            marginBottom={1}
          >
            <Box
              flexDirection="row"
              justifyContent="space-between"
              marginBottom={1}
            >
              <Text bold color="cyan">
                Selector de Modelos (/model)
              </Text>
              <Text color="gray">
                ←/→ cambiar familia · ↑/↓ elegir · Enter confirmar · Esc salir
              </Text>
            </Box>

            {pendingModelForEffort ? (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color="white">
                  Selecciona el nivel de ESFUERZO para {pendingModelForEffort.name}{' '}
                  (←/→ y Enter, Esc volver):
                </Text>
                <Box flexDirection="row" marginTop={1}>
                  {pendingModelForEffort.supportedEfforts.map((ef, idx) => {
                    const isChosen = idx === modelEffortIdx;
                    return (
                      <Box key={ef} marginRight={3}>
                        <Text
                          bold={isChosen}
                          color={isChosen ? 'cyan' : 'white'}
                        >
                          {isChosen
                            ? `❯ [${ef.toUpperCase()}]`
                            : `  ${ef.toUpperCase()}`}
                        </Text>
                      </Box>
                    );
                  })}
                </Box>
              </Box>
            ) : (
              <>
                <Box flexDirection="row" marginBottom={1}>
                  <Text color="cyan" bold>
                    {'◄ '}
                  </Text>
                  {modelPages.map((page, pIdx) => {
                    const isCurrentPage = pIdx === modelPageIdx;
                    return (
                      <Box key={page.family} marginRight={2}>
                        <Text
                          bold={isCurrentPage}
                          color={isCurrentPage ? 'cyan' : 'gray'}
                        >
                          {`[Pág ${pIdx + 1}/${modelPages.length}: ${page.title}]`}
                        </Text>
                      </Box>
                    );
                  })}
                  <Text color="cyan" bold>
                    {'►'}
                  </Text>
                </Box>

                <Box flexDirection="column" marginBottom={1}>
                  <Text bold color="white">
                    {'  '}
                    {'NOMBRE DEL MODELO'.padEnd(36, ' ')}
                    {' | '}
                    {'ID MODELO'.padEnd(32, ' ')}
                    {' | '}
                    {'FECHA'.padEnd(10, ' ')}
                    {' | '}
                    {'ESFUERZO'}
                  </Text>
                  <Text color="gray">{'  ' + '─'.repeat(104)}</Text>
                </Box>

                {(modelPages[modelPageIdx]?.models ?? []).map((m, idx) => {
                  const isSelected = idx === dialogCursor;
                  const isCurrent = m.id === settings.model;
                  const cols = formatModelRowColumns(m, isCurrent, 36, 32, 10);
                  return (
                    <Box key={m.id} flexDirection="row">
                      <Text
                        color={isSelected ? 'cyan' : 'white'}
                        bold={isSelected}
                      >
                        {isSelected ? '❯ ' : '  '}
                        {cols.nameCol}
                      </Text>
                      <Text color="gray">{' | '}</Text>
                      <Text color={isSelected ? 'cyan' : 'gray'}>
                        {cols.idCol}
                      </Text>
                      <Text color="gray">{' | '}</Text>
                      <Text color={isSelected ? 'cyan' : 'green'}>
                        {cols.dateCol}
                      </Text>
                      <Text color="gray">{' | '}</Text>
                      <Text color={isSelected ? 'cyan' : 'yellow'}>
                        {cols.effortsCol}
                      </Text>
                    </Box>
                  );
                })}
              </>
            )}
          </Box>
        )}

        {/* Diálogo interactivo /settings (/ajustes) con opción de Idioma Español/English */}
        {activeDialog === 'settings' && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={2}
            paddingY={1}
            marginBottom={1}
          >
            <Text bold color="cyan">
              {lang === 'en'
                ? 'Preferences Panel (/settings) — ↑/↓ select, Enter/←/→ change, Esc close'
                : 'Panel de Preferencias (/ajustes) — ↑/↓ seleccionar, Enter/←/→ cambiar, Esc cerrar'}
            </Text>
            <Text color={dialogCursor === 0 ? 'cyan' : 'white'}>
              {dialogCursor === 0 ? '❯ ' : '  '}
              {lang === 'en' ? 'Permission Mode             : ' : 'Modo de permisos            : '}
              {formatPermissionModeLabel(settings.permissionMode)}
            </Text>
            <Text color={dialogCursor === 1 ? 'cyan' : 'white'}>
              {dialogCursor === 1 ? '❯ ' : '  '}
              {lang === 'en' ? 'Sub-Mode                    : ' : 'Sub-Modo                    : '}
              {formatSubModeLabel(settings.subMode, lang)}
            </Text>
            <Text color={dialogCursor === 2 ? 'cyan' : 'white'}>
              {dialogCursor === 2 ? '❯ ' : '  '}
              {lang === 'en' ? 'Default Effort              : ' : 'Esfuerzo por defecto        : '}
              {settings.effort.toUpperCase()}
            </Text>
            <Text color={dialogCursor === 3 ? 'cyan' : 'white'}>
              {dialogCursor === 3 ? '❯ ' : '  '}Thoughts                    :{' '}
              {settings.thoughts ? 'ON' : 'OFF'}
            </Text>
            <Text color={dialogCursor === 4 ? 'cyan' : 'white'}>
              {dialogCursor === 4 ? '❯ ' : '  '}
              {lang === 'en' ? '--DAA Startup Warning       : ' : 'Advertencia --DAA al inicio : '}
              {settings.hideDaaWarning ? 'OFF' : 'ON'}
            </Text>
            <Text color={dialogCursor === 5 ? 'cyan' : 'white'}>
              {dialogCursor === 5 ? '❯ ' : '  '}
              {lang === 'en' ? 'Language / Idioma           : ' : 'Idioma / Language           : '}
              {lang === 'en' ? 'English' : 'Español'}
            </Text>
          </Box>
        )}
      </Box>

      {/* ZONA INFERIOR ANCLADA ABAJO */}
      <Box flexDirection="column">
        {showShortcutsPanel && activeDialog === 'none' && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={2}
            paddingY={1}
            marginBottom={1}
          >
            <Text bold color="cyan">
              {lang === 'en'
                ? 'Quick Shortcuts & Commands (press ? again to hide)'
                : 'Atajos y Comandos Rápidos (presiona ? de nuevo para ocultar)'}
            </Text>
            {SLASH_COMMANDS.map((sc) => (
              <Text key={sc.cmd} color="white">
                {`  ${sc.displayCmd[lang].padEnd(24, ' ')} ${sc.desc[lang]}`}
              </Text>
            ))}
            <Text color="white">
              {lang === 'en'
                ? '  ← (Left Arrow)            Open Live Agents, Active Chats & History'
                : '  ← (Flecha izquierda)      Abrir Agentes y Chats en tiempo real + Historial'}
            </Text>
            <Text color="white">
              {lang === 'en'
                ? '  Shift+Tab / Alt+P         Toggle Sub-Mode Plan <-> Agent live'
                : '  Shift+Tab / Alt+P         Alternar Sub-Modo Plan <-> Agente en vivo'}
            </Text>
            <Text color="white">
              {lang === 'en'
                ? '  Ctrl+C (x2)               Press twice to confirm and exit Glitch CLI'
                : '  Ctrl+C (x2)               Presionar dos veces para confirmar y salir'}
            </Text>
            <Text color="gray">
              {'  Flags CLI: glitch --DAA | glitch --dangerously-always-allow | glitch --model <id> | glitch -m "<id>"'}
            </Text>
          </Box>
        )}

        {/* TUI de confirmación al borrar completamente un elemento de la fila de espera */}
        {confirmDeleteQueueIdx !== null && (
          <Box
            borderStyle="round"
            borderColor="red"
            paddingX={2}
            marginBottom={0}
          >
            <Text color="red" bold>
              {lang === 'en'
                ? `⚠ Delete queued prompt at position #${confirmDeleteQueueIdx + 1}? [Enter / Y = Yes, delete · Esc / N = Cancel]`
                : `⚠ ¿Borrar posición #${confirmDeleteQueueIdx + 1} de la fila de espera? [Enter / S = Sí, borrar · Esc / N = Cancelar]`}
            </Text>
          </Box>
        )}

        {/* Aviso de doble Ctrl+C para salir */}
        {ctrlCPending && (
          <Box
            borderStyle="round"
            borderColor="yellow"
            paddingX={2}
            marginBottom={0}
          >
            <Text color="yellow" bold>
              {lang === 'en'
                ? '⚠ Press Ctrl + C again to confirm and exit Glitch CLI.'
                : '⚠ Presiona Ctrl + C otra vez para confirmar y salir de Glitch CLI.'}
            </Text>
          </Box>
        )}

        {queuedPrompts.length > 0 && activeDialog === 'none' && (
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="yellow"
            paddingX={1}
          >
            <Text color="yellow" bold>
              {lang === 'en'
                ? `⏳ Queued (${queuedPrompts.length}) — use ↑/↓ to select, Enter to edit in place, or clear text to delete:`
                : `⏳ En fila de espera (${queuedPrompts.length}) — usa ↑/↓ para elegir, Enter para editar en su posición o borra el texto para eliminar:`}
            </Text>
            {queuedPrompts.map((qp, idx) => {
              const isEditingThis = editingQueueIdx === idx;
              return (
                <Text
                  key={idx}
                  color={isEditingThis ? 'cyan' : 'white'}
                  bold={isEditingThis}
                >
                  {isEditingThis ? '✎ ' : '  '}#{idx + 1}: {qp}
                  {isEditingThis
                    ? lang === 'en'
                      ? ' (editing this position)'
                      : ' (editando en esta posición)'
                    : ''}
                </Text>
              );
            })}
          </Box>
        )}

        {matchingSlash.length > 0 && activeDialog === 'none' && (
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
          >
            {matchingSlash.map((item, idx) => (
              <Box key={item.cmd} flexDirection="row">
                <Text color={idx === suggestionIdx ? 'cyan' : 'white'} bold>
                  {idx === suggestionIdx ? '❯ ' : '  '}
                  {item.displayCmd[lang].padEnd(14, ' ')}
                </Text>
                <Text color="gray">{item.desc[lang]}</Text>
              </Box>
            ))}
          </Box>
        )}

        {/* Barra justo arriba del chat: Izquierda (Modo + Sub-Modo) | Derecha (% Contexto · MCP activos · Skills) */}
        {activeDialog === 'none' && (
          <Box
            flexDirection="row"
            justifyContent="space-between"
            paddingX={1}
          >
            <Text color={modeColor} bold>
              {formatInputTopLeftMode(settings)}
            </Text>
            <Text color="gray">
              {formatInputTopRightInfo(
                sessionRef.current.history,
                envCounts.mcpCount,
                envCounts.skillCount,
                lang,
              )}
            </Text>
          </Box>
        )}

        {/* Caja de entrada anclada abajo */}
        {activeDialog === 'none' && (
          <Box
            borderStyle="round"
            borderColor={editingQueueIdx !== null ? 'yellow' : 'gray'}
            paddingX={1}
          >
            <Text color={editingQueueIdx !== null ? 'yellow' : 'cyan'} bold>
              {editingQueueIdx !== null
                ? `[${lang === 'en' ? 'Queue' : 'Cola'} #${editingQueueIdx + 1}] › `
                : `${msgPrefixLabel} ${userTurnCounter + 1} > `}
            </Text>
            {inputText.length > 0 ? (
              <Text color="white">{inputText}█</Text>
            ) : (
              <Text color="gray">
                {lang === 'en'
                  ? 'Ask Glitch CLI anything or type / for commands (← for chats)...'
                  : 'Pide a Glitch CLI lo que quieras o escribe / para comandos (← para chats)...'}
              </Text>
            )}
          </Box>
        )}

        {/* Barra inferior: ? para atajos y ← para chats a la izquierda | Modelo y Esfuerzo a la derecha */}
        <Box
          flexDirection="row"
          justifyContent="space-between"
          paddingX={1}
          marginTop={0}
        >
          <Text color="gray">
            {lang === 'en'
              ? '? for shortcuts · ← chats & agents · Ctrl+C (x2) exit'
              : '? para atajos · ← chats y agentes · Ctrl+C (x2) salir'}
          </Text>
          <Text color="cyan">{formatStatusBar(settings)}</Text>
        </Box>
      </Box>
    </Box>
  );
};
