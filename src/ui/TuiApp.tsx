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
} from '../config/models.js';
import { runEffortCommand } from '../commands/effort.js';
import { toggleSubMode } from '../permissions/permissions.js';
import {
  GLITCH_ASCII_LINES,
  IGLITCHOFF_WORDMARK,
  formatShortCwd,
} from './banner.js';
import { formatStatusBar } from './statusBar.js';
import { SessionState } from '../core/session.js';
import {
  VertexProviderAdapter,
  createVertexGenAI,
} from '../providers/vertex.js';
import { CustomProviderAdapter } from '../providers/custom.js';
import type { ProviderAdapter } from '../providers/types.js';

interface UiMessage {
  id: string;
  role: 'user' | 'model' | 'system';
  text: string;
  thoughtText?: string;
}

type ActiveDialog = 'none' | 'auth' | 'model' | 'settings';

const SLASH_COMMANDS = [
  { cmd: '/auth', desc: 'Configurar conexión (Vertex AI o API personalizada)' },
  { cmd: '/model', desc: 'Seleccionar modelo por páginas (←/→ familia, ↑/↓ modelo)' },
  { cmd: '/effort', desc: 'Ver o cambiar nivel de esfuerzo en vivo (low | medium | high)' },
  { cmd: '/settings', desc: 'Preferencias (Modo, Sub-Modo Plan/Agent, Esfuerzo, Thoughts, Aviso --DAA)' },
  { cmd: '/help', desc: 'Mostrar comandos, flags (-m, --model, --DAA) y atajos' },
  { cmd: '/exit', desc: 'Salir de Glitch CLI' },
];

export interface TuiAppProps {
  initialSettings: GlitchSettings;
  version?: string;
}

export const TuiApp: React.FC<TuiAppProps> = ({
  initialSettings,
  version = '0.1.0',
}) => {
  const { exit } = useApp();
  useStdout();
  const columns = process.stdout.columns ?? 100;

  const sessionRef = useRef<SessionState>(new SessionState(initialSettings));
  const [settings, setSettings] = useState<GlitchSettings>(initialSettings);
  const [availableModels, setAvailableModels] = useState(
    sessionRef.current.availableModels,
  );

  // Pantalla de peligro --DAA de 3 segundos al iniciar (si permissionMode es always_allow y no está oculta en /settings)
  const shouldShowDaaSplash =
    initialSettings.permissionMode === 'always_allow' &&
    !initialSettings.hideDaaWarning;
  const [daaSplashSeconds, setDaaSplashSeconds] = useState<number>(
    shouldShowDaaSplash ? 3 : 0,
  );

  const [messages, setMessages] = useState<UiMessage[]>([]);
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

  // Estado del diálogo /model y /settings
  const [dialogCursor, setDialogCursor] = useState(0);
  const [modelPageIdx, setModelPageIdx] = useState(0);
  const modelPages = groupModelsByFamilyPages(availableModels);

  const syncSettings = (next: GlitchSettings) => {
    sessionRef.current.settings = next;
    setSettings({ ...next });
    saveSettings(next);
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

  // Temporizador de 3 segundos para la pantalla de advertencia --DAA
  useEffect(() => {
    if (daaSplashSeconds <= 0) return;
    const timer = setTimeout(() => {
      if (daaSplashSeconds === 1) {
        setDaaSplashSeconds(0);
        addSystemMessage(
          '⚠ Modo --DAA (Always Allow sin sandbox) activo. Si quieres desactivar este mensaje de advertencia al iniciar, configúralo en /settings (Advertencia --DAA al inicio: OFF).',
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
    activeDialog === 'none' &&
    inputText.startsWith('/') &&
    !inputText.includes(' ')
      ? SLASH_COMMANDS.filter((s) =>
          s.cmd.startsWith(inputText.toLowerCase()),
        )
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
    setIsStreaming(true);
    setLiveThought('');
    setLiveText('');

    setMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}-u`, role: 'user', text: userPrompt },
    ]);
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

      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random()}-m`,
          role: 'model',
          text: accText || '(sin respuesta de texto)',
          thoughtText: accThought || undefined,
        },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addSystemMessage(`✗ Error: ${msg}`);
    }
  };

  const startOrEnqueuePrompt = (userPrompt: string) => {
    const session = sessionRef.current;

    // Si ya hay una petición activa, el mensaje entra a la fila (Queue) en orden FIFO
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

    if (trimmed === '/exit') {
      exit();
      return;
    }

    if (trimmed === '/help' || trimmed === '?') {
      addSystemMessage(
        [
          'Comandos dentro de Glitch CLI:',
          '  /auth                     Selector de conexión (Vertex AI ADC / API personalizada)',
          '  /model [id]               Selector de modelos por páginas (←/→ familia, ↑/↓ modelo)',
          '  /effort [low|medium|high] Cambiar o consultar el nivel de esfuerzo en vivo',
          '  /settings                 Panel interactivo (Modo, Sub-Modo, Esfuerzo, Thoughts, Aviso --DAA)',
          '  /help                     Mostrar esta ayuda',
          '  /exit                     Salir de Glitch CLI',
          '',
          'Ramas de ejecución al iniciar en terminal:',
          '  glitch --DAA                        Iniciar en modo Always Allow sin sandbox (acceso total al PC)',
          '  glitch --dangerously-always-allow   Equivalente a --DAA',
          '  glitch --model gemini-2.5-flash     Iniciar directamente con un modelo específico',
          '  glitch -m "gemini-2.5-flash"        Forma corta para elegir modelo al iniciar',
          '',
          'Atajos y Fila de Espera (Queue):',
          '  Shift+Tab / Alt+P         Alternar Sub-Modo Plan <-> Agent en vivo',
          '  ↑ / ↓ con cola activa     Subir/bajar entre los prompts en fila (Queue) y Enter para reemplazar en su misma posición',
        ].join(os.EOL),
      );
      return;
    }

    if (trimmed === '/auth') {
      setAuthStep('provider');
      setAuthChoiceIdx(0);
      setAuthBuffer('');
      setActiveDialog('auth');
      return;
    }

    if (trimmed === '/settings') {
      setDialogCursor(0);
      setActiveDialog('settings');
      return;
    }

    if (trimmed === '/model' || trimmed.startsWith('/model ')) {
      if (sessionRef.current.isRequestActive) {
        addSystemMessage(
          '⚠ No puedes cambiar de modelo mientras hay una petición activa. Espera a que termine la tarea actual.',
        );
        return;
      }
      const arg = trimmed.slice('/model'.length).trim();
      if (arg) {
        const exists = availableModels.find((m) => m.id === arg);
        if (!exists && (settings.provider ?? 'vertex') === 'vertex') {
          addSystemMessage(`✗ Modelo "${arg}" no disponible en Vertex AI.`);
          return;
        }
        const def = getModelDefinition(arg, settings.provider ?? 'vertex');
        const nextEffort =
          def.supportedEfforts.length > 0 &&
          !def.supportedEfforts.includes(settings.effort)
            ? (def.defaultEffort ?? def.supportedEfforts[0]!)
            : settings.effort;
        const updated: GlitchSettings = {
          ...settings,
          model: def.id,
          effort: nextEffort,
        };
        syncSettings(updated);
        addSystemMessage(`✓ Modelo cambiado a ${def.name} (${updated.model}).`);
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
      setModelPageIdx(foundPageIdx);
      setDialogCursor(currentIdx);
      setActiveDialog('model');
      return;
    }

    if (trimmed === '/effort' || trimmed.startsWith('/effort ')) {
      const arg = trimmed.slice('/effort'.length).trim();
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

    if (trimmed.startsWith('/')) {
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
      addSystemMessage(
        `⇄ Sub-Modo cambiado en vivo a: ${nextSubMode === 'plan' ? 'Plan (solo planear)' : 'Agent (modificación activa)'}`,
      );
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

    // Manejo del diálogo /model (con paginación por familia ← / →)
    if (activeDialog === 'model') {
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
          const nextEffort =
            picked.supportedEfforts.length > 0 &&
            !picked.supportedEfforts.includes(settings.effort)
              ? (picked.defaultEffort ?? picked.supportedEfforts[0]!)
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

    // Manejo del diálogo /settings (5 opciones)
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

    // Autocompletado de Slash Commands cuando se escribe /
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
      // Si estamos editando un prompt de la cola (ej. subimos 2 veces al #2 de 3), se actualiza en esa MISMA posición de la fila
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

  // TUI de peligro de 3 segundos para --DAA (--dangerously-always-allow)
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
          ⚠ ADVERTENCIA DE SEGURIDAD: MODO --DAA (--dangerously-always-allow) ACTIVO
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">
            • Glitch CLI se está ejecutando en modo Always Allow y SIN SANDBOX.
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

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Cabecera estilo Codex CLI + iGlitchOff */}
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

      {/* Historial de conversación */}
      {messages.map((m) => (
        <Box key={m.id} flexDirection="column" marginBottom={1}>
          {m.role === 'user' && (
            <Box>
              <Text color="cyan" bold>
                {'› '}
              </Text>
              <Text color="white" bold>
                {m.text}
              </Text>
            </Box>
          )}
          {m.role === 'model' && (
            <Box flexDirection="column" paddingLeft={2}>
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
              <Text color="white">{m.text}</Text>
            </Box>
          )}
          {m.role === 'system' && (
            <Box paddingLeft={2}>
              <Text color="yellow">{m.text}</Text>
            </Box>
          )}
        </Box>
      ))}

      {/* Respuesta en vivo (Streaming) */}
      {isStreaming && (
        <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
          <Text color="cyan">
            ⚡ Generando respuesta en vivo... (envía más mensajes a la fila o usa /effort y Shift+Tab)
          </Text>
          {liveThought && settings.thoughts && (
            <Box borderStyle="single" borderColor="gray" paddingX={1}>
              <Text color="gray" italic>
                💭 {liveThought}
              </Text>
            </Box>
          )}
          {liveText && <Text color="white">{liveText}</Text>}
        </Box>
      )}

      {/* Fila de espera (Queue FIFO) visible con soporte de edición ↑ / ↓ */}
      {queuedPrompts.length > 0 && activeDialog === 'none' && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="yellow"
          paddingX={1}
          marginBottom={0}
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

          {/* Pestañas de familias */}
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

          {/* Encabezado de tabla separada */}
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

          {/* Filas de la familia actual (ordenadas de más reciente a más antiguo) */}
          {(modelPages[modelPageIdx]?.models ?? []).map((m, idx) => {
            const isSelected = idx === dialogCursor;
            const isCurrent = m.id === settings.model;
            const cols = formatModelRowColumns(m, isCurrent, 36, 32, 10);
            return (
              <Box key={m.id} flexDirection="row">
                <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                  {isSelected ? '❯ ' : '  '}
                  {cols.nameCol}
                </Text>
                <Text color="gray">{' | '}</Text>
                <Text color={isSelected ? 'cyan' : 'gray'}>{cols.idCol}</Text>
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

      {/* Menú autocompletado de Slash Commands */}
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

      {/* Caja de entrada estilo Gemini CLI / Codex CLI */}
      {activeDialog === 'none' && (
        <Box
          borderStyle="round"
          borderColor={editingQueueIdx !== null ? 'yellow' : 'gray'}
          paddingX={1}
        >
          <Text color={editingQueueIdx !== null ? 'yellow' : 'cyan'} bold>
            {editingQueueIdx !== null
              ? `[Editando Cola #${editingQueueIdx + 1}] › `
              : '› '}
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

      {/* Barra de estado inferior sin corchetes y con nombre físico del modelo */}
      <Box
        flexDirection="row"
        justifyContent="space-between"
        paddingX={1}
        marginTop={0}
      >
        <Text color="gray">? para atajos · Shift+Tab alterna Plan/Agent</Text>
        <Text color="cyan">{formatStatusBar(settings)}</Text>
      </Box>
    </Box>
  );
};
