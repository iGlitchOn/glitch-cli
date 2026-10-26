import os from 'node:os';
import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Part } from '@google/genai';
import {
  formatAuthSummary,
  formatPermissionModeLabel,
  isAuthConfigured,
  maskApiKey,
  saveSettings,
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

type ActiveDialog = 'none' | 'auth' | 'model' | 'settings' | 'resume';

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
  const [liveThought, setLiveThought] = useState('');
  const [liveText, setLiveText] = useState('');
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(() =>
    isAuthConfigured(initialSettings) ? 'none' : 'auth',
  );
  const [suggestionIdx, setSuggestionIdx] = useState(0);

  // Cola FIFO de prompts en espera y edición en su misma posición con ↑ / ↓
  const queueRef = useRef<string[]>([]);
  const [queuedPrompts, setQueuedPrompts] = useState<string[]>([]);
  const [editingQueueIdx, setEditingQueueIdx] = useState<number | null>(null);
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

  // Estado de diálogos /model, /settings y /resume
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
          '⚠ Flag --DAA activa: si quieres desactivar este mensaje inicial de 3 segundos, configúralo en /settings (Advertencia --DAA al inicio: OFF).',
        );
      } else {
        setDaaSplashSeconds((prev) => prev - 1);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [daaSplashSeconds]);

  useEffect(() => {
    if (isAuthConfigured(initialSettings)) {
      void refreshModels(initialSettings);
    }
  }, []);

  const matchingSlash =
    activeDialog === 'none' ? matchSlashCommands(inputText) : [];

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
    setIsStreaming(true);
    setLiveThought('');
    setLiveText('');

    const userMsg: SavedUiMessage = {
      id: `${Date.now()}-${Math.random()}-u`,
      role: 'user',
      text: userPrompt,
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
      })) {
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
      };
      setMessages((prev) => {
        const next = [...prev, modelMsg];
        persistCurrentSession(next);
        return next;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addSystemMessage(`✗ Error: ${msg}`);
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

  const executeInputCommand = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    const resolved = trimmed.startsWith('/')
      ? resolveSlashCommandAlias(trimmed)
      : trimmed;

    if (resolved === '/exit') {
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
      const list = listSavedSessions();
      if (list.length === 0) {
        addSystemMessage(
          'ℹ No hay conversaciones guardadas todavía para retomar con /resume.',
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
          '⚠ No puedes cambiar de modelo mientras hay una petición activa. Espera a que termine la tarea actual.',
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
        `✗ Comando desconocido: ${trimmed}. Usa /help para ver los comandos disponibles.`,
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
    if (daaSplashSeconds > 0) {
      return;
    }

    // Atajo global en vivo: Shift+Tab o Alt+P alterna Sub-Modo Plan <-> Agent
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

    // Manejo del diálogo /settings
    if (activeDialog === 'settings') {
      if (key.escape) {
        setActiveDialog('none');
        return;
      }
      if (key.upArrow) {
        setDialogCursor((prev) => (prev > 0 ? prev - 1 : 4));
        return;
      }
      if (key.downArrow) {
        setDialogCursor((prev) => (prev < 4 ? prev + 1 : 0));
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
        }
        return;
      }
      return;
    }

    // Autocompletado de Slash Commands (si buscas /clear o /cl se selecciona el original /new)
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
          setInputText(chosen.cmd + ' ');
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
          setEditingQueueIdx(targetIdx);
          setInputText(q[targetIdx] ?? '');
        } else if (editingQueueIdx > 0) {
          const targetIdx = editingQueueIdx - 1;
          setEditingQueueIdx(targetIdx);
          setInputText(q[targetIdx] ?? '');
        }
        return;
      }
      if (key.downArrow && editingQueueIdx !== null) {
        const q = queueRef.current;
        if (editingQueueIdx < q.length - 1) {
          const targetIdx = editingQueueIdx + 1;
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
        if (replacement) {
          queueRef.current[editingQueueIdx] = replacement;
          syncQueueState();
        }
        setEditingQueueIdx(null);
        setInputText(draftInputRef.current);
        draftInputRef.current = '';
        return;
      }

      if (
        matchingSlash.length > 0 &&
        !inputText.trim().includes(' ') &&
        inputText.trim() !== matchingSlash[suggestionIdx]?.cmd &&
        !SLASH_COMMANDS.some((s) => s.cmd === inputText.trim())
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
          (Puedes desactivar esta advertencia inicial en /settings → Advertencia --DAA al inicio: OFF)
        </Text>
      </Box>
    );
  }

  const artWidth = GLITCH_ASCII_LINES[0]?.length ?? 80;
  const artPad = ' '.repeat(Math.max(0, Math.floor((columns - artWidth) / 2)));

  // Calcula numeración Mensaje N > y Respuesta N >
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

        {/* Historial numerado: Mensaje N > y Respuesta N > */}
        {numberedMessages.map((m) => (
          <Box key={m.id} flexDirection="column" marginBottom={1}>
            {m.role === 'user' && (
              <Box>
                <Text color="cyan" bold>
                  {`Mensaje ${m.turnNumber} > `}
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
                    {`Respuesta ${m.turnNumber} > `}
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

        {/* Respuesta en vivo numerada (Streaming) */}
        {isStreaming && (
          <Box flexDirection="column" marginBottom={1}>
            <Text color="cyan">
              ⚡ Generando Respuesta {nextStreamingReplyNumber}... (envía más mensajes a la fila o usa /effort y Shift+Tab)
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
                  {`Respuesta ${nextStreamingReplyNumber} > `}
                </Text>
                <Text color="white">{liveText}</Text>
              </Box>
            )}
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

        {/* Diálogo interactivo /settings */}
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
              Panel de Preferencias (/settings) — ↑/↓ seleccionar, Enter/←/→ cambiar, Esc cerrar
            </Text>
            <Text color={dialogCursor === 0 ? 'cyan' : 'white'}>
              {dialogCursor === 0 ? '❯ ' : '  '}Modo de permisos            :{' '}
              {formatPermissionModeLabel(settings.permissionMode)}
            </Text>
            <Text color={dialogCursor === 1 ? 'cyan' : 'white'}>
              {dialogCursor === 1 ? '❯ ' : '  '}Sub-Modo                    :{' '}
              {settings.subMode === 'plan'
                ? 'Plan (solo planear)'
                : 'Agent (modificar)'}
            </Text>
            <Text color={dialogCursor === 2 ? 'cyan' : 'white'}>
              {dialogCursor === 2 ? '❯ ' : '  '}Esfuerzo por defecto        :{' '}
              {settings.effort.toUpperCase()}
            </Text>
            <Text color={dialogCursor === 3 ? 'cyan' : 'white'}>
              {dialogCursor === 3 ? '❯ ' : '  '}Thoughts                    :{' '}
              {settings.thoughts ? 'ON' : 'OFF'}
            </Text>
            <Text color={dialogCursor === 4 ? 'cyan' : 'white'}>
              {dialogCursor === 4 ? '❯ ' : '  '}Advertencia --DAA al inicio :{' '}
              {settings.hideDaaWarning ? 'OFF' : 'ON'}
            </Text>
          </Box>
        )}
      </Box>

      {/* ZONA INFERIOR ANCLADA ABAJO: Panel ? + Cola + Menú Slash + Barra sobre el Chat + Caja de Chat + Pie */}
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
              Atajos y Comandos Rápidos (presiona ? de nuevo para ocultar)
            </Text>
            <Text color="white">
              {'  /new                      Iniciar conversación limpia'}
            </Text>
            <Text color="white">
              {'  /resume                   Retomar una conversación anterior guardada'}
            </Text>
            <Text color="white">
              {'  /model [id] [effort]      Seleccionar modelo y esfuerzo (ej. /model gemini-4-argon high)'}
            </Text>
            <Text color="white">
              {'  /effort [low|medium|high] Cambiar esfuerzo en vivo sin reiniciar'}
            </Text>
            <Text color="white">
              {'  /settings                 Panel de Modo, Sub-Modo, Esfuerzo, Thoughts y Aviso --DAA'}
            </Text>
            <Text color="white">
              {'  Shift+Tab / Alt+P         Alternar Sub-Modo Plan <-> Agent en vivo'}
            </Text>
            <Text color="white">
              {'  ↑ / ↓ con cola activa     Subir/bajar en la fila (Queue) y Enter para editar en esa posición'}
            </Text>
            <Text color="gray">
              {'  Flags CLI: glitch --DAA | glitch --dangerously-always-allow | glitch --model <id> | glitch -m "<id>"'}
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
              ⏳ En fila de espera ({queuedPrompts.length}) — usa ↑/↓ para elegir y Enter para editar en su misma posición:
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
                  {isEditingThis ? ' (editando en esta posición)' : ''}
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
                  {item.cmd.padEnd(12, ' ')}
                </Text>
                <Text color="gray">{item.desc}</Text>
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
                ? `[Editando Cola #${editingQueueIdx + 1}] › `
                : `Mensaje ${userTurnCounter + 1} > `}
            </Text>
            {inputText.length > 0 ? (
              <Text color="white">{inputText}█</Text>
            ) : (
              <Text color="gray">
                Pide a Glitch CLI lo que quieras o escribe / para comandos...
              </Text>
            )}
          </Box>
        )}

        {/* Barra inferior: ? para atajos a la izquierda | Modelo y Esfuerzo a la derecha */}
        <Box
          flexDirection="row"
          justifyContent="space-between"
          paddingX={1}
          marginTop={0}
        >
          <Text color="gray">? para atajos</Text>
          <Text color="cyan">{formatStatusBar(settings)}</Text>
        </Box>
      </Box>
    </Box>
  );
};
