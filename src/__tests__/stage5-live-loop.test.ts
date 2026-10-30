import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThinkingLevel, type Content, type GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../config/settings.js';
import {
  clearApiRequestDebugLogs,
  getApiRequestDebugLogs,
} from '../config/models.js';
import { runEffortCommand } from '../commands/effort.js';
import { runModelCommand } from '../commands/model.js';
import { VertexProviderAdapter } from '../providers/vertex.js';
import {
  computeContextUsageBreakdown,
  formatCostAuditReport,
  formatStatusBar,
} from '../ui/statusBar.js';
import {
  matchSlashCommands,
  resolveSlashCommandAlias,
} from '../commands/slashRegistry.js';
import {
  TurnRunner,
  runSingleTurn,
  type ThinkingBlockSummaryEvent,
  type TurnToolResultEvent,
  type TurnToolStartEvent,
  type TurnUsageEvent,
} from '../core/turnRunner.js';
import { formatCollapsedThoughtLine } from '../core/thinkingBlocks.js';
import { SessionState } from '../core/session.js';
import {
  buildFallbackTopicTitle,
  cleanSessionTitle,
  countCompletedConversationTurns,
  countRealUserTurns,
  deriveSessionTitle,
  generateSessionSummaryTitle,
  isBareGreetingMessage,
  listSavedSessions,
  saveSessionToDisk,
} from '../core/sessionStore.js';
import {
  buildUserPartsWithImages,
  getRegisteredImagePath,
  registerPastedImagePath,
  snapshotPastedImageMap,
  transformPastedChunkWithImages,
} from '../core/clipboard.js';
import {
  createCompactionTracker,
  maybeAutoCompactContext,
  resetCompactionTrackerForNewTurn,
} from '../core/compaction.js';
import {
  InputUndoManager,
  createLineEditorState,
  deleteBackwardAtCursor,
  deleteWordBackwardAtCursor,
  formatQueueItemDisplayLine,
  insertTextAtCursor,
  moveCursorEnd,
  moveCursorHome,
  moveCursorLeft,
  moveCursorRight,
} from '../core/lineEditor.js';
import {
  GLITCH_TOOL_DECLARATIONS,
  buildGlitchSystemInstruction,
  executeGlitchToolCall,
  runShellCommandAsync,
} from '../core/tools.js';
import { discoverMcpServers } from '../core/mcpRegistry.js';
import { discoverSkills } from '../core/skills.js';
import {
  continueSubagentFromLimit,
  formatSubagentOutcomeForModel,
  getRunningSubagents,
  sendSubagentCorrection,
  startSubagentInBackground,
  type LiveSubagentInfo,
} from '../core/subagents.js';
import {
  computeAgentsTableColumnWidths,
  filterSavedSessionsForPanel,
  groupSubagentsByRound,
  truncateAndPadColumn,
} from '../ui/AgentsPanelView.js';
import type {
  ProviderAdapter,
  ProviderRequestOptions,
  ProviderStreamChunk,
} from '../providers/types.js';

describe('Etapa 5: Loop unificado en turnRunner.ts', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glitch-stage5-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('cambia /effort low en vivo mientras una tarea corre en high y la siguiente llamada de la misma tarea usa low', async () => {
    const session = new SessionState({
      ...DEFAULT_SETTINGS,
      provider: 'vertex',
      vertex: { project: 'proj-live', location: 'us-central1' },
      model: 'gemini-4-argon',
      effort: 'high',
    });

    let callCount = 0;
    let releaseFirstCall!: () => void;
    const firstCallStarted = new Promise<void>((res) => {
      releaseFirstCall = res;
    });
    let allowFirstCallToFinish!: () => void;
    const firstCallGate = new Promise<void>((res) => {
      allowFirstCallToFinish = res;
    });

    const fakeAdapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(
        _history: readonly Content[],
        options: ProviderRequestOptions,
      ): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        callCount++;
        if (callCount === 1) {
          releaseFirstCall();
          await firstCallGate;
        }
        yield {
          text: `paso-${callCount}-${options.effort}`,
          rawParts: [{ text: `paso-${callCount}-${options.effort}` }],
        };
      },
    };

    const logs: string[] = [];
    const streamed: string[] = [];

    const runner = new TurnRunner(
      session,
      () => fakeAdapter,
      (t) => streamed.push(t),
      (e) => logs.push(e),
      {
        shouldContinueTask: (stepIndex) => stepIndex < 2,
      },
    );

    const queuedTask = runner.enqueuePrompt('Analiza el sistema en dos pasos');
    await firstCallStarted;
    expect(session.isRequestActive).toBe(true);

    session.settings = await runModelCommand(
      session.settings,
      session.availableModels,
      session.isRequestActive,
      'gemini-2.5-pro',
      async () => '',
      (m) => logs.push(m),
      tempHome,
    );
    expect(session.settings.model).toBe('gemini-4-argon');
    expect(logs.some((l) => l.includes('petición activa'))).toBe(true);

    session.settings = runEffortCommand(
      session.settings,
      'low',
      (m) => logs.push(m),
      tempHome,
    );
    expect(session.settings.effort).toBe('low');

    allowFirstCallToFinish();
    await queuedTask;

    expect(session.isRequestActive).toBe(false);
    expect(runner.recordedCallConfigs).toHaveLength(2);
    expect(runner.recordedCallConfigs[0]?.effort).toBe('high');
    expect(runner.recordedCallConfigs[1]?.effort).toBe('low');
    expect(streamed).toEqual(['paso-1-high', 'paso-2-low']);
  });

  it('encola múltiples mensajes en fila FIFO y permite subir 2 veces entre 3 encolados para editar el 2do en su misma posición', async () => {
    const session = new SessionState({
      ...DEFAULT_SETTINGS,
      provider: 'vertex',
      vertex: { project: 'proj-queue', location: 'us-central1' },
      model: 'gemini-4-argon',
      effort: 'medium',
    });

    let callIndex = 0;
    let releaseFirstCall!: () => void;
    const firstCallStarted = new Promise<void>((res) => {
      releaseFirstCall = res;
    });
    let allowFirstCallToFinish!: () => void;
    const firstCallGate = new Promise<void>((res) => {
      allowFirstCallToFinish = res;
    });

    const receivedUserPrompts: string[] = [];

    const fakeAdapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(
        history: readonly Content[],
      ): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        callIndex++;
        const lastUserText = history.at(-1)?.parts?.[0]?.text ?? '';
        receivedUserPrompts.push(lastUserText);
        if (callIndex === 1) {
          releaseFirstCall();
          await firstCallGate;
        }
        yield {
          text: `respuesta-${callIndex}`,
          rawParts: [{ text: `respuesta-${callIndex}` }],
        };
      },
    };

    const runner = new TurnRunner(session, () => fakeAdapter, () => {});

    const activePromise = runner.enqueuePrompt('Tarea inicial corriendo');
    await firstCallStarted;

    void runner.enqueuePrompt('Prompt en cola 1');
    void runner.enqueuePrompt('Prompt en cola 2 (original)');
    void runner.enqueuePrompt('Prompt en cola 3');

    expect(runner.getQueuedPrompts()).toEqual([
      'Prompt en cola 1',
      'Prompt en cola 2 (original)',
      'Prompt en cola 3',
    ]);

    const targetIdx = runner.getQueueIndexFromStepsUp(2);
    expect(targetIdx).toBe(1);
    const updatedOk = runner.updateQueuedPromptAt(
      targetIdx,
      'Prompt en cola 2 (EDITADO)',
    );
    expect(updatedOk).toBe(true);
    expect(runner.getQueuedPrompts()).toEqual([
      'Prompt en cola 1',
      'Prompt en cola 2 (EDITADO)',
      'Prompt en cola 3',
    ]);

    expect(runner.removeQueuedPromptAt(2)).toBe(true);
    expect(runner.getQueuedPrompts()).toEqual([
      'Prompt en cola 1',
      'Prompt en cola 2 (EDITADO)',
    ]);

    allowFirstCallToFinish();
    await activePromise;

    expect(receivedUserPrompts).toEqual([
      'Tarea inicial corriendo',
      'Prompt en cola 1',
      'Prompt en cola 2 (EDITADO)',
    ]);
  });

  it('mapea alternativas y comandos en español/inglés (/esfuerzo -> /effort, /ajustes -> /settings, /cl, /clear -> /new) y guarda/retoma sesiones correctamente', () => {
    const matchesCl = matchSlashCommands('/cl');
    expect(matchesCl[0]?.cmd).toBe('/new');
    const matchesClear = matchSlashCommands('/clear');
    expect(matchesClear[0]?.cmd).toBe('/new');
    expect(resolveSlashCommandAlias('/clear')).toBe('/new');
    expect(resolveSlashCommandAlias('/nuevo')).toBe('/new');
    expect(resolveSlashCommandAlias('/esfuerzo high')).toBe('/effort high');
    expect(resolveSlashCommandAlias('/ajustes')).toBe('/settings');
    expect(resolveSlashCommandAlias('/continue 1')).toBe('/resume 1');

    const session = new SessionState({ ...DEFAULT_SETTINGS });

    saveSessionToDisk(
      {
        id: 'ses-test-1',
        title: 'Sesión guardada de prueba',
        createdAt: '2026-10-25 10:00:00',
        updatedAt: '2026-10-25 10:05:00',
        model: 'gemini-4-argon',
        effort: 'high',
        history: [
          { role: 'user', parts: [{ text: 'Hola mundo' }] },
          { role: 'model', parts: [{ text: 'Hola!' }] },
        ],
        messages: [],
      },
      tempHome,
    );

    const saved = listSavedSessions(tempHome);
    expect(saved).toHaveLength(1);
    session.history.push(...saved[0]!.history);
    expect(session.history).toHaveLength(2);

    session.history.length = 0;
    expect(session.history).toHaveLength(0);

    const skills = discoverSkills(tempHome);
    const mcps = discoverMcpServers(tempHome);
    const breakdown = computeContextUsageBreakdown(
      session.history,
      session.settings.subMode,
      skills,
      [],
      undefined,
      mcps,
      session.lastApiPromptTokenCount,
    );
    expect(breakdown.baseSystemTokens).toBeGreaterThan(50);
    expect(breakdown.toolSchemaTokens).toBeGreaterThan(100);
  });

  it('ejecuta runSingleTurn con callbacks (onText, onThought, onToolStart, onToolResult, onUsage) y AbortSignal', async () => {
    const externalFile = path.join(tempHome, 'external-system-test.txt');
    const session = new SessionState({
      ...DEFAULT_SETTINGS,
      permissionMode: 'always_allow',
      subMode: 'agent',
    });

    let turn = 0;
    const fakeAdapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(
        _history: readonly Content[],
        options: ProviderRequestOptions,
      ): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        turn++;
        expect(options.enableTools).toBe(true);
        expect(options.systemInstruction).toContain('ACCESO TOTAL');
        if (turn === 1) {
          yield {
            thoughtText: 'Necesito primero escribir el archivo en tempHome.',
            rawParts: [
              {
                text: 'Necesito primero escribir el archivo en tempHome.',
                thought: true,
              },
              {
                functionCall: {
                  id: 'fc-write-1',
                  name: 'write_file',
                  args: {
                    file_path: externalFile,
                    content: 'contenido-sin-sandbox-123',
                  },
                },
              },
            ],
          };
          return;
        }
        if (turn === 2) {
          yield {
            thoughtText: 'Ahora debo leer el archivo para verificar su contenido.',
            rawParts: [
              {
                text: 'Ahora debo leer el archivo para verificar su contenido.',
                thought: true,
              },
              {
                functionCall: {
                  id: 'fc-read-2',
                  name: 'read_file',
                  args: {
                    file_path: externalFile,
                  },
                },
              },
            ],
          };
          return;
        }
        yield {
          text: 'Archivo escrito y verificado correctamente en el PC.',
          rawParts: [
            { text: 'Archivo escrito y verificado correctamente en el PC.' },
          ],
          usage: {
            inputTokens: 1000,
            outputTokens: 200,
            cachedTokens: 0,
            reasoningTokens: 100,
            totalPromptTokens: 1000,
          },
        };
      },
    };

    const eventsOrder: string[] = [];
    const toolStarts: TurnToolStartEvent[] = [];
    const toolResults: TurnToolResultEvent[] = [];
    const usageEvents: TurnUsageEvent[] = [];

    const res = await runSingleTurn({
      session,
      userPrompt: 'Crea y lee un archivo en tempHome',
      getAdapter: () => fakeAdapter,
      onThought: (delta) => eventsOrder.push(`thought:${delta}`),
      onText: (delta) => eventsOrder.push(`text:${delta}`),
      onStepMessage: (step) => {
        if (step.thoughtText) {
          eventsOrder.push(`stepThought:${step.thoughtText}`);
        }
      },
      onToolStart: (ev) => {
        toolStarts.push(ev);
        eventsOrder.push(`toolStart:${ev.name}`);
      },
      onToolResult: (ev) => {
        toolResults.push(ev);
        eventsOrder.push(`toolResult:${ev.name}`);
      },
      onUsage: (ev) => usageEvents.push(ev),
    });

    expect(res.aborted).toBe(false);
    expect(res.finalText).toBe(
      'Archivo escrito y verificado correctamente en el PC.',
    );
    expect(turn).toBe(3);
    expect(fs.readFileSync(externalFile, 'utf-8')).toBe(
      'contenido-sin-sandbox-123',
    );
    expect(toolStarts.map((t) => t.name)).toEqual(['write_file', 'read_file']);
    expect(toolResults.map((t) => t.name)).toEqual(['write_file', 'read_file']);
    expect(usageEvents.some((u) => u.phase === 'committed')).toBe(true);

    const idxThought1 = eventsOrder.findIndex((e) =>
      e.includes('stepThought:Necesito primero escribir'),
    );
    const idxTool1 = eventsOrder.indexOf('toolStart:write_file');
    const idxThought2 = eventsOrder.findIndex((e) =>
      e.includes('stepThought:Ahora debo leer'),
    );
    const idxTool2 = eventsOrder.indexOf('toolStart:read_file');
    expect(idxThought1).toBeGreaterThanOrEqual(0);
    expect(idxThought1).toBeLessThan(idxTool1);
    expect(idxThought2).toBeGreaterThan(idxTool1);
    expect(idxThought2).toBeLessThan(idxTool2);
  });

  it('verifica la herramienta ask_user con allowAgentQuestions en ON y en OFF (modo AFK) y recuperación ante "TypeError: fetch failed sending request" a mitad del turno', async () => {
    const askDecl = GLITCH_TOOL_DECLARATIONS.find((d) => d.name === 'ask_user');
    expect(askDecl).toBeDefined();

    const sysOn = buildGlitchSystemInstruction('agent', [], [], true);
    expect(sysOn).toContain('usa la función/herramienta ask_user');

    const sysOff = buildGlitchSystemInstruction('agent', [], [], false);
    expect(sysOff).toContain('allowAgentQuestions=OFF');

    const offOutcome = executeGlitchToolCall(
      'ask_user',
      {
        question: '¿Uso SQLite o Postgres?',
        header: 'Base de datos',
        options: ['SQLite', 'Postgres'],
      },
      'always_allow',
      'agent',
      [],
      undefined,
      false,
    );
    expect(offOutcome.result).toBe(
      'Modo autónomo sin supervisión (allowAgentQuestions=OFF): toma la decisión más robusta por tu cuenta y continúa sin esperar al usuario',
    );

    const sessionOn = new SessionState({
      ...DEFAULT_SETTINGS,
      permissionMode: 'always_allow',
      subMode: 'agent',
      allowAgentQuestions: true,
    });

    let attemptCounter = 0;
    let turnStep = 0;
    const fakeAdapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(
        history: readonly Content[],
      ): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        attemptCounter++;
        if (attemptCounter === 1) {
          throw new TypeError('fetch failed sending request');
        }
        turnStep++;
        if (turnStep === 1) {
          yield {
            rawParts: [
              {
                functionCall: {
                  id: 'call_ask_1',
                  name: 'ask_user',
                  args: {
                    question: '¿Qué arquitectura prefieres?',
                    header: 'Arquitectura',
                    options: ['Modular', 'Monolito'],
                  },
                },
              },
            ],
          };
          return;
        }
        const lastFnResp = history.at(-1)?.parts?.[0]?.functionResponse;
        const chosen = (lastFnResp?.response as Record<string, unknown>)?.[
          'result'
        ];
        yield {
          text: `Continuando con la opción elegida: ${String(chosen)}`,
          rawParts: [
            { text: `Continuando con la opción elegida: ${String(chosen)}` },
          ],
        };
      },
    };

    const streamedLogs: string[] = [];
    const runner = new TurnRunner(
      sessionOn,
      () => fakeAdapter,
      (t) => streamedLogs.push(t),
      () => {},
      {
        retryOptions: { maxRetries: 5, baseDelayMs: 1 },
        onAskUser: async (prompt) => {
          expect(prompt.question).toBe('¿Qué arquitectura prefieres?');
          expect(prompt.options).toEqual(['Modular', 'Monolito']);
          return 'Modular';
        },
      },
    );

    await runner.enqueuePrompt('Diseña el sistema');

    const fullOutput = streamedLogs.join('');
    expect(fullOutput).toContain(
      'Reconectando tras fallo de red (intento 1/5)...',
    );
    expect(fullOutput).toContain('Continuando con la opción elegida: Modular');
  });

  it('convierte imágenes pegadas con Ctrl+V o click derecho en [NOMBRE DE LA IMAGEN] para la UI e inyecta la ruta + inlineData internamente para la IA', () => {
    const fakeImgPath = path.join(tempHome, 'captura-error.png');
    fs.writeFileSync(fakeImgPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const uiTag = registerPastedImagePath(fakeImgPath);
    expect(uiTag).toBe('[captura-error.png]');

    const rightClickPaste = transformPastedChunkWithImages(`"${fakeImgPath}"`);
    expect(rightClickPaste.trim()).toBe('[captura-error.png]');

    const userVisiblePrompt = `Mira este fallo ${uiTag} y dime cómo arreglarlo`;
    const parts = buildUserPartsWithImages(userVisiblePrompt);

    expect(parts.length).toBe(2);
    expect(parts[0]?.inlineData?.mimeType).toBe('image/png');
    expect(parts[0]?.inlineData?.data).toBeTruthy();
    expect(parts[1]?.text).toContain(userVisiblePrompt);
    expect(parts[1]?.text).toContain(`Ruta interna: ${path.normalize(fakeImgPath)}`);
  });

  it('permite mover el cursor con flechas/Home/End para editar en medio del mensaje, borrar palabras con Shift+Backspace y truncar visualmente la cola (#N - ...)', () => {
    let state = createLineEditorState('Hola mundo largo');
    expect(state.cursor).toBe(16);

    for (let i = 0; i < 6; i++) {
      state = moveCursorLeft(state);
    }
    expect(state.cursor).toBe(10);

    state = deleteBackwardAtCursor(state);
    expect(state.text).toBe('Hola mund largo');

    state = insertTextAtCursor(state, 'os');
    expect(state.text).toBe('Hola mundos largo');

    state = moveCursorHome(state);
    expect(state.cursor).toBe(0);
    state = moveCursorEnd(state);
    expect(state.cursor).toBe(17);
    state = moveCursorRight(moveCursorHome(state));
    expect(state.cursor).toBe(1);

    state = moveCursorEnd(state);
    state = deleteWordBackwardAtCursor(state);
    expect(state.text).toBe('Hola mundos ');

    const longPrompt =
      'Con click derecho o Ctrl+V se deben poder pegar imagenes y analizarlas internamente';
    const truncatedLine = formatQueueItemDisplayLine(longPrompt, 1, true, 52);
    expect(truncatedLine.startsWith('> #1 - Con click derecho')).toBe(true);
    expect(truncatedLine.endsWith('...')).toBe(true);
    expect(longPrompt).toContain('analizarlas internamente');
  });

  it('ejecuta autocompactación al alcanzar el umbral, conserva los últimos turnos, evita compactar 2 veces seguidas si el resumen sigue alto y no borra historial si falla', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'Me llamo Carlos y quiero crear A. '.repeat(60) }] },
      { role: 'model', parts: [{ text: 'Creando módulo A en src/a.ts. '.repeat(60) }] },
      { role: 'user', parts: [{ text: 'Ahora agrega soporte para B. '.repeat(60) }] },
      { role: 'model', parts: [{ text: 'Agregado B en src/b.ts. '.repeat(60) }] },
      { role: 'user', parts: [{ text: 'Por último implementa C.' }] },
    ];

    const compactingStates: boolean[] = [];
    const tracker = createCompactionTracker();

    const successAdapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        yield {
          text: 'Resumen: el usuario se llama Carlos, pidió A, B y C, se modificaron src/a.ts y src/b.ts, falta terminar C.',
        };
      },
    };

    const res = await maybeAutoCompactContext({
      history,
      settings: {
        ...DEFAULT_SETTINGS,
        autoCompact: true,
        autoCompactThreshold: 70,
      },
      adapter: successAdapter,
      currentUserPrompt: 'Por último implementa C.',
      availableSkills: [],
      activeSkillContents: [],
      tracker,
      maxTokens: 2500,
      onCompactingStatusChange: (flag) => compactingStates.push(flag),
    });

    expect(res.compacted).toBe(true);
    expect(compactingStates).toEqual([true, false]);
    expect(res.chatDisplayBlock).toContain(
      'Resumen: el usuario se llama Carlos, pidió A, B y C',
    );
    expect(
      history.some((h) =>
        h.parts?.some((p) => p.text?.includes('Por último implementa C.')),
      ),
    ).toBe(true);

    const failingHistory: Content[] = [
      { role: 'user', parts: [{ text: 'Texto grande '.repeat(200) }] },
      { role: 'model', parts: [{ text: 'Respuesta grande '.repeat(200) }] },
    ];
    const failTracker = createCompactionTracker();
    let failCalls = 0;
    const failingAdapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        failCalls++;
        throw new Error('Sub-agent error');
      },
    };

    const failRes1 = await maybeAutoCompactContext({
      history: failingHistory,
      settings: {
        ...DEFAULT_SETTINGS,
        autoCompact: true,
        autoCompactThreshold: 50,
      },
      adapter: failingAdapter,
      currentUserPrompt: 'Sigue',
      availableSkills: [],
      activeSkillContents: [],
      tracker: failTracker,
      maxTokens: 1000,
    });
    expect(failRes1.compacted).toBe(false);
    expect(failingHistory).toHaveLength(2);
    expect(failRes1.warningMessage).toContain('Se conserva el historial intacto');

    const failRes2 = await maybeAutoCompactContext({
      history: failingHistory,
      settings: {
        ...DEFAULT_SETTINGS,
        autoCompact: true,
        autoCompactThreshold: 50,
      },
      adapter: failingAdapter,
      currentUserPrompt: 'Sigue',
      availableSkills: [],
      activeSkillContents: [],
      tracker: failTracker,
      maxTokens: 1000,
    });
    expect(failRes2.compacted).toBe(false);
    expect(failCalls).toBe(1);

    resetCompactionTrackerForNewTurn(failTracker);
    await maybeAutoCompactContext({
      history: failingHistory,
      settings: {
        ...DEFAULT_SETTINGS,
        autoCompact: true,
        autoCompactThreshold: 50,
      },
      adapter: failingAdapter,
      currentUserPrompt: 'Nuevo turno',
      availableSkills: [],
      activeSkillContents: [],
      tracker: failTracker,
      maxTokens: 1000,
    });
    expect(failCalls).toBe(2);
  });

  it('soporta deshacer/rehacer (Ctrl+Z / Ctrl+Y) agrupando escritura/borrado, pasos únicos en paste/delete_word/load_queue, límite de 100 pasos y limpieza de referencias de imágenes', () => {
    const undoMgr = new InputUndoManager(100);
    let state = createLineEditorState('');
    const baseTs = 10_000;

    expect(undoMgr.undo(state)).toBeNull();
    expect(undoMgr.redo(state)).toBeNull();

    for (const [idx, ch] of ['H', 'o', 'l', 'a', ' '].entries()) {
      const next = insertTextAtCursor(state, ch);
      undoMgr.recordEdit(state, next, 'type_char', ch, baseTs + idx * 100);
      state = next;
    }
    expect(state.text).toBe('Hola ');
    expect(undoMgr.getUndoCount()).toBe(1);

    for (const [idx, ch] of ['m', 'u', 'n', 'd', 'o'].entries()) {
      const next = insertTextAtCursor(state, ch);
      undoMgr.recordEdit(state, next, 'type_char', ch, baseTs + 600 + idx * 50);
      state = next;
    }
    expect(state.text).toBe('Hola mundo');
    expect(undoMgr.getUndoCount()).toBe(2);

    const imgPath = path.join(tempHome, 'undo-img-test.png');
    fs.writeFileSync(imgPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const beforePasteRefs = snapshotPastedImageMap();
    const tag = registerPastedImagePath(imgPath);
    expect(getRegisteredImagePath('undo-img-test.png')).toBe(
      path.normalize(imgPath),
    );

    const afterPaste = insertTextAtCursor(state, ` ${tag}`);
    undoMgr.recordEdit(
      state,
      afterPaste,
      'paste',
      ` ${tag}`,
      baseTs + 900,
      beforePasteRefs,
    );
    state = afterPaste;
    expect(state.text).toBe('Hola mundo [undo-img-test.png]');
    expect(undoMgr.getUndoCount()).toBe(3);

    const undonePaste = undoMgr.undo(state)!;
    expect(undonePaste).not.toBeNull();
    state = undonePaste;
    expect(state.text).toBe('Hola mundo');
    expect(getRegisteredImagePath('undo-img-test.png')).toBeUndefined();

    const redonePaste = undoMgr.redo(state)!;
    expect(redonePaste).not.toBeNull();
    state = redonePaste;
    expect(state.text).toBe('Hola mundo [undo-img-test.png]');
    expect(getRegisteredImagePath('undo-img-test.png')).toBe(
      path.normalize(imgPath),
    );

    state = undoMgr.undo(state)!;
    expect(undoMgr.getRedoCount()).toBe(1);
    const afterNewChar = insertTextAtCursor(state, '!');
    undoMgr.recordEdit(state, afterNewChar, 'type_char', '!', baseTs + 3000);
    state = afterNewChar;
    expect(undoMgr.getRedoCount()).toBe(0);

    const afterDeleteWord = deleteWordBackwardAtCursor(state);
    undoMgr.recordEdit(state, afterDeleteWord, 'delete_word', '', baseTs + 3100);
    state = afterDeleteWord;
    expect(state.text).toBe('Hola ');
    state = undoMgr.undo(state)!;
    expect(state.text).toBe('Hola mundo!');

    for (let i = 0; i < 120; i++) {
      const next = insertTextAtCursor(state, 'x');
      undoMgr.recordEdit(state, next, 'paste', 'x', baseTs + 5000 + i * 10);
      state = next;
    }
    expect(undoMgr.getUndoCount()).toBe(100);

    undoMgr.clear();
    expect(undoMgr.getUndoCount()).toBe(0);
    expect(undoMgr.getRedoCount()).toBe(0);
  });

  it('aplica inmediatamente el cambio de esfuerzo de Alto a Bajo en la siguiente petición (incluidos reintentos y llamadas a herramientas), lo registra en el log debug y sincroniza la barra inferior', async () => {
    clearApiRequestDebugLogs();

    const session = new SessionState({
      ...DEFAULT_SETTINGS,
      provider: 'vertex',
      vertex: { project: 'test-proj', location: 'us-central1' },
      model: 'gemini-4-argon',
      effort: 'high',
      subMode: 'agent',
    });

    expect(formatStatusBar(session.settings)).toBe(
      'Gemini 4 Argon | Esfuerzo: Alto',
    );

    const capturedSdkCalls: Array<{
      model: string;
      thinkingLevel?: ThinkingLevel;
    }> = [];
    let sdkCallCount = 0;

    const fakeVertexAi = {
      models: {
        generateContentStream: async (params: {
          model: string;
          config?: { thinkingConfig?: { thinkingLevel?: ThinkingLevel } };
        }) => {
          sdkCallCount++;
          capturedSdkCalls.push({
            model: params.model,
            thinkingLevel: params.config?.thinkingConfig?.thinkingLevel,
          });

          if (sdkCallCount === 2) {
            session.settings = runEffortCommand(
              session.settings,
              'bajo',
              () => {},
              tempHome,
            );
            throw new TypeError('fetch failed sending request');
          }

          return (async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [{ text: `Respuesta #${sdkCallCount}` }],
                  },
                },
              ],
            };
          })();
        },
      },
    } as unknown as GoogleGenAI;

    const vertexAdapter = new VertexProviderAdapter(fakeVertexAi, {
      maxRetries: 3,
      baseDelayMs: 1,
    });

    const loop = new TurnRunner(
      session,
      () => vertexAdapter,
      () => {},
      () => {},
      { retryOptions: { maxRetries: 3, baseDelayMs: 1 } },
    );

    await loop.enqueuePrompt('Primer mensaje en esfuerzo alto');
    expect(capturedSdkCalls[0]?.thinkingLevel).toBe(ThinkingLevel.HIGH);

    await loop.enqueuePrompt('Segundo mensaje que cambia a bajo en vivo');
    expect(capturedSdkCalls[1]?.thinkingLevel).toBe(ThinkingLevel.HIGH);
    expect(capturedSdkCalls[2]?.thinkingLevel).toBe(ThinkingLevel.LOW);
    expect(formatStatusBar(session.settings)).toBe(
      'Gemini 4 Argon | Esfuerzo: Bajo',
    );

    await loop.enqueuePrompt('Tercer mensaje ya en bajo');
    expect(capturedSdkCalls[3]?.thinkingLevel).toBe(ThinkingLevel.LOW);
    expect(session.history.length).toBe(6);

    const debugLogs = getApiRequestDebugLogs();
    expect(debugLogs.length).toBeGreaterThanOrEqual(4);
    expect(
      debugLogs.some(
        (d) => d.effort === 'high' && d.thinkingParameter.includes('HIGH'),
      ),
    ).toBe(true);
    expect(
      debugLogs.some(
        (d) => d.effort === 'low' && d.thinkingParameter.includes('LOW'),
      ),
    ).toBe(true);
    expect(debugLogs.at(-1)?.effort).toBe('low');

    const warnings: string[] = [];
    const mismatchedSettings = {
      ...session.settings,
      model: 'gemini-4-argon-cyber-permissive',
      effort: 'low' as const,
    };
    const statusAfterReconcile = formatStatusBar(mismatchedSettings, (w) =>
      warnings.push(w),
    );
    expect(statusAfterReconcile).toBe(
      'Gemini 4 Argon Cyber Permissive | Esfuerzo: Alto',
    );
    expect(mismatchedSettings.effort).toBe('high');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('se corrigió a Alto');
  });

  it('contabiliza la entrada completa de cada petición en el bucle de herramientas (promptTokenCount, thoughtsTokenCount, toolUsePromptTokenCount), actualiza el contador real de contexto y muestra reporte de costos', async () => {
    const session = new SessionState({
      ...DEFAULT_SETTINGS,
      provider: 'vertex',
      vertex: { project: 'test-proj', location: 'us-central1' },
      model: 'gemini-4-argon',
      effort: 'high',
      subMode: 'agent',
    });

    let callStep = 0;
    const fakeVertexAi = {
      models: {
        generateContentStream: async () => {
          callStep++;
          if (callStep === 1) {
            return (async function* () {
              yield {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            id: 'call_ls_1',
                            name: 'list_directory',
                            args: { dir_path: tempHome },
                          },
                        },
                      ],
                    },
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 100_000,
                  candidatesTokenCount: 2_000,
                  thoughtsTokenCount: 8_000,
                  totalTokenCount: 110_000,
                },
              };
            })();
          }
          return (async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [{ text: 'Listado completado con éxito.' }],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 112_000,
                cachedContentTokenCount: 12_000,
                candidatesTokenCount: 3_000,
                thoughtsTokenCount: 7_000,
                totalTokenCount: 122_000,
              },
            };
          })();
        },
      },
    } as unknown as GoogleGenAI;

    const vertexAdapter = new VertexProviderAdapter(fakeVertexAi);
    const loop = new TurnRunner(
      session,
      () => vertexAdapter,
      () => {},
      () => {},
    );

    await loop.enqueuePrompt('Revisa la carpeta temporal');

    expect(session.costRecords).toHaveLength(2);
    expect(session.costRecords[0]?.inputTokens).toBe(100_000);
    expect(session.costRecords[1]?.inputTokens).toBe(100_000);
    expect(session.costRecords[1]?.cachedTokens).toBe(12_000);
    // El contador de contexto se calcula como: prompt de la última petición (112,000) + salida (3,000) + thoughts (7,000) = 122,000
    expect(session.lastApiPromptTokenCount).toBe(122_000);

    const totalCost = session.costRecords.reduce<number | null>((acc, r) => {
      if (r.costUsd === null) return null;
      return (acc ?? 0) + r.costUsd;
    }, 0);
    const debugOutput = formatCostAuditReport(
      session.costRecords,
      totalCost,
      totalCost,
      session.settings.model,
      session.settings.modelPricing,
    ).join('\n');
    expect(debugOutput).toContain('#1 [T1·agent] gemini-4-argon');
    expect(debugOutput).toContain('#2 [T1·tool_followup] gemini-4-argon');
    expect(debugOutput).toContain('toolPrompt=no reportado');
  });

  it('ejecuta subagentes nativos en paralelo (spawn_parallel_subagents y spawn_subagent) y comandos shell asíncronos sin congelar el event loop', async () => {
    const subDecl = GLITCH_TOOL_DECLARATIONS.find(
      (d) => d.name === 'spawn_subagent',
    );
    const parDecl = GLITCH_TOOL_DECLARATIONS.find(
      (d) => d.name === 'spawn_parallel_subagents',
    );
    expect(subDecl).toBeDefined();
    expect(parDecl).toBeDefined();

    const ac = new AbortController();
    let timerTickedWhileRunning = false;
    const tickTimer = setTimeout(() => {
      timerTickedWhileRunning = true;
      ac.abort();
    }, 60);

    const shellStart = Date.now();
    const shellRes = await runShellCommandAsync(
      'node -e "setTimeout(() => {}, 10000)"',
      os.tmpdir(),
      ac.signal,
      15_000,
    );
    clearTimeout(tickTimer);
    const shellDuration = Date.now() - shellStart;

    expect(timerTickedWhileRunning).toBe(true);
    expect(shellDuration).toBeLessThan(4000);
    expect(shellRes.error).toContain('cancelado por el usuario');

    const session = new SessionState({
      ...DEFAULT_SETTINGS,
      permissionMode: 'always_allow',
      subMode: 'agent',
    });

    const subagentUpdates: LiveSubagentInfo[] = [];
    let mainAgentStep = 0;

    const parallelFakeAdapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(
        history: readonly Content[],
        options: ProviderRequestOptions,
      ): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        const sys = options.systemInstruction ?? '';
        if (sys.includes('ROL DE SUBAGENTE AUTÓNOMO:')) {
          await new Promise((r) => setTimeout(r, 30));
          const userTask = history[0]?.parts?.[0]?.text ?? '';
          yield {
            text: `Reporte completado para: ${userTask}`,
            rawParts: [{ text: `Reporte completado para: ${userTask}` }],
            usage: {
              inputTokens: 1000,
              outputTokens: 500,
              cachedTokens: 0,
              reasoningTokens: 0,
              toolUsePromptTokens: 0,
              totalPromptTokens: 1000,
            },
          };
          return;
        }

        mainAgentStep++;
        if (mainAgentStep === 1) {
          yield {
            rawParts: [
              {
                functionCall: {
                  id: 'call_par_1',
                  name: 'spawn_parallel_subagents',
                  args: {
                    agents: [
                      {
                        name: 'Agente 1 - Buscador Marketplace',
                        task: 'Buscar iPhones en Marketplace',
                      },
                      {
                        name: 'Agente 2 - Vigilante Messenger',
                        task: 'Responder chats de Messenger en vivo',
                      },
                    ],
                  },
                },
              },
            ],
          };
          return;
        }

        if (mainAgentStep === 2) {
          const launchResp = history.at(-1)?.parts?.[0]?.functionResponse
            ?.response as Record<string, unknown> | undefined;
          expect(String(launchResp?.['result'] ?? '')).toContain('lanzado:');
          yield {
            rawParts: [
              {
                functionCall: {
                  id: 'call_wait_1',
                  name: 'esperar_subagentes',
                  args: {},
                },
              },
            ],
          };
          return;
        }

        const fnResp = history.at(-1)?.parts?.[0]?.functionResponse?.response as
          | Record<string, unknown>
          | undefined;
        const combinedResult = String(fnResp?.['result'] ?? '');
        yield {
          text: `Ambos subagentes terminaron:\n${combinedResult}`,
          rawParts: [{ text: `Ambos subagentes terminaron:\n${combinedResult}` }],
        };
      },
    };

    const streamedLogs: string[] = [];
    const loop = new TurnRunner(
      session,
      () => parallelFakeAdapter,
      (t) => streamedLogs.push(t),
      () => {},
      {
        onSubagentUpdate: (info) => subagentUpdates.push(info),
      },
    );

    await loop.enqueuePrompt('Corre los dos agentes en paralelo');

    const fullOut = streamedLogs.join('');
    expect(fullOut).toContain('Agente 1 - Buscador Marketplace');
    expect(fullOut).toContain('Agente 2 - Vigilante Messenger');
    expect(fullOut).toContain('Reporte completado para: Buscar iPhones en Marketplace');
    expect(fullOut).toContain('Reporte completado para: Responder chats de Messenger en vivo');
    expect(
      subagentUpdates.some(
        (u) =>
          u.name === 'Agente 1 - Buscador Marketplace' &&
          u.status === 'completed',
      ),
    ).toBe(true);
    expect(
      subagentUpdates.some(
        (u) =>
          u.name === 'Agente 2 - Vigilante Messenger' &&
          u.status === 'completed',
      ),
    ).toBe(true);
  });

  it('lanza 2 subagentes independientes, encola un mensaje, aborta con ESC y verifica cola vacía, 0 subagentes en running, historial válido con functionResponse y estado ocupado apagado', async () => {
    const session = new SessionState({
      ...DEFAULT_SETTINGS,
      permissionMode: 'always_allow',
      subMode: 'agent',
    });

    let subagentsStarted = 0;
    let notifyBothSubagentsRunning!: () => void;
    const bothSubagentsRunning = new Promise<void>((res) => {
      notifyBothSubagentsRunning = res;
    });

    let mainStep = 0;
    const adapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(
        _history: readonly Content[],
        options: ProviderRequestOptions,
      ): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        const sys = options.systemInstruction ?? '';
        if (sys.includes('ROL DE SUBAGENTE AUTÓNOMO:')) {
          subagentsStarted++;
          if (subagentsStarted === 2) {
            notifyBothSubagentsRunning();
          }
          // El subagente ejecuta un comando colgado que debe morir al abortar
          yield {
            rawParts: [
              {
                functionCall: {
                  id: `sub-cmd-${subagentsStarted}`,
                  name: 'run_shell_command',
                  args: {
                    command: 'node -e "setTimeout(() => {}, 20000)"',
                  },
                },
              },
            ],
          };
          return;
        }

        mainStep++;
        if (mainStep === 1) {
          yield {
            rawParts: [
              {
                functionCall: {
                  id: 'fc-spawn-2',
                  name: 'spawn_parallel_subagents',
                  args: {
                    agents: [
                      { name: 'Sub 1', task: 'Tarea larga 1' },
                      { name: 'Sub 2', task: 'Tarea larga 2' },
                    ],
                  },
                },
              },
            ],
          };
          return;
        }

        // Paso 2 del principal: llama a esperar_subagentes y otra herramienta en paralelo
        yield {
          rawParts: [
            {
              functionCall: {
                id: 'fc-wait-all',
                name: 'esperar_subagentes',
                args: {},
              },
            },
            {
              functionCall: {
                id: 'fc-hang-cmd',
                name: 'run_shell_command',
                args: {
                  command: 'node -e "setTimeout(() => {}, 20000)"',
                },
              },
            },
          ],
        };
      },
    };

    const latestSubagentMap = new Map<string, LiveSubagentInfo>();
    const logs: string[] = [];
    const runner = new TurnRunner(
      session,
      () => adapter,
      (t) => logs.push(t),
      (e) => logs.push(e),
      {
        onSubagentUpdate: (info) => {
          latestSubagentMap.set(info.id, info);
        },
      },
    );

    const activeTask = runner.enqueuePrompt('Lanza 2 subagentes');
    void runner.enqueuePrompt('Mensaje en cola que debe descartarse');
    expect(runner.getQueuedPrompts()).toEqual([
      'Mensaje en cola que debe descartarse',
    ]);

    await bothSubagentsRunning;
    await new Promise((r) => setTimeout(r, 60));

    const abortStart = Date.now();
    const dropped = runner.abortCurrentTurn();
    await activeTask;
    const abortDuration = Date.now() - abortStart;

    expect(dropped).toBe(1);
    expect(logs.join('')).toContain('se descartaron 1 mensajes en fila');
    expect(runner.getQueuedPrompts()).toEqual([]);
    expect(session.isRequestActive).toBe(false);
    expect(abortDuration).toBeLessThan(4000);
    expect(getRunningSubagents()).toHaveLength(0);
    for (const sub of latestSubagentMap.values()) {
      expect(sub.status).not.toBe('running');
    }

    // Verifica que el historial nunca quedó con functionCall sin functionResponse
    for (let i = 0; i < session.history.length; i++) {
      const turn = session.history[i]!;
      const fcs = (turn.parts ?? []).filter((p) => Boolean(p.functionCall?.name));
      if (fcs.length > 0) {
        const nextTurn = session.history[i + 1];
        expect(nextTurn?.role).toBe('user');
        const fnResps = (nextTurn?.parts ?? []).filter((p) =>
          Boolean(p.functionResponse?.name),
        );
        expect(fnResps.length).toBeGreaterThanOrEqual(fcs.length);
      }
    }
  });

  it('interrumpe esperar_subagentes ante una corrección del usuario sin matar los subagentes en segundo plano', async () => {
    const session = new SessionState({
      ...DEFAULT_SETTINGS,
      permissionMode: 'always_allow',
      subMode: 'agent',
    });

    let releaseSubagent!: () => void;
    const subagentGate = new Promise<void>((res) => {
      releaseSubagent = res;
    });

    let mainStep = 0;
    const seenResponses: string[] = [];

    const adapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(
        history: readonly Content[],
        options: ProviderRequestOptions,
      ): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        const sys = options.systemInstruction ?? '';
        if (sys.includes('ROL DE SUBAGENTE AUTÓNOMO:')) {
          await subagentGate;
          yield {
            text: 'Subagente terminó intacto tras la corrección',
            rawParts: [{ text: 'Subagente terminó intacto tras la corrección' }],
          };
          return;
        }

        mainStep++;
        if (mainStep === 1) {
          yield {
            rawParts: [
              {
                functionCall: {
                  id: 'fc-spawn-corr',
                  name: 'spawn_subagent',
                  args: { name: 'Sub Vivo', task: 'Investigar API' },
                },
              },
            ],
          };
          return;
        }

        if (mainStep === 2) {
          // Mientras el principal entra a esperar_subagentes, simulamos corrección del usuario tras 30ms
          setTimeout(() => {
            loop.stepControllerRef.interruptCurrentStepForCorrection(
              'Corrección prioritaria del usuario para Sub Vivo',
            );
          }, 30);
          yield {
            rawParts: [
              {
                functionCall: {
                  id: 'fc-wait-corr',
                  name: 'esperar_subagentes',
                  args: {},
                },
              },
            ],
          };
          return;
        }

        if (mainStep === 3) {
          const lastUserParts = history.at(-1)?.parts ?? [];
          seenResponses.push(JSON.stringify(lastUserParts));
          // Ahora liberamos al subagente que siguió vivo y esperamos su reporte
          releaseSubagent();
          yield {
            rawParts: [
              {
                functionCall: {
                  id: 'fc-wait-final',
                  name: 'esperar_subagentes',
                  args: {},
                },
              },
            ],
          };
          return;
        }

        const finalFnResp = history.at(-1)?.parts?.[0]?.functionResponse
          ?.response as Record<string, unknown> | undefined;
        yield {
          text: `Resultado final: ${String(finalFnResp?.['result'] ?? '')}`,
          rawParts: [
            { text: `Resultado final: ${String(finalFnResp?.['result'] ?? '')}` },
          ],
        };
      },
    };

    const streamed: string[] = [];
    const loop = new TurnRunner(
      session,
      () => adapter,
      (t) => streamed.push(t),
    );

    await loop.enqueuePrompt('Prueba corrección en vivo');

    expect(seenResponses.join(' ')).toContain(
      'interrumpido por corrección del usuario',
    );
    expect(seenResponses.join(' ')).toContain(
      'Corrección prioritaria del usuario para Sub Vivo',
    );
    expect(streamed.join('')).toContain(
      'Subagente terminó intacto tras la corrección',
    );
  });

  it('runSingleTurn detiene el stream inmediatamente al activarse AbortSignal y apaga isRequestActive', async () => {
    const session = new SessionState({
      ...DEFAULT_SETTINGS,
      permissionMode: 'always_allow',
      subMode: 'agent',
    });
    const ac = new AbortController();

    const slowAdapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        yield { text: 'Iniciando ' };
        ac.abort();
        yield { text: 'texto que no debe procesarse' };
      },
    };

    const stepMessages: string[] = [];
    const outcome = await runSingleTurn({
      session,
      userPrompt: 'Prueba de abort en turnRunner',
      getAdapter: () => slowAdapter,
      abortSignal: ac.signal,
      onStepMessage: (m) => stepMessages.push(m.text),
    });

    expect(outcome.aborted).toBe(true);
    expect(session.isRequestActive).toBe(false);
    expect(stepMessages.length).toBe(1);
  });

  it('Paso 6: pensamiento por bloques (cerrado por el modelo con cerrar_bloque, respaldo a las 6 rondas, fallo del resumidor, costo thinking_summary sumado y sin placeholder cuando no hay thoughts)', async () => {
    const cerrarDecl = GLITCH_TOOL_DECLARATIONS.find(
      (d) => d.name === 'cerrar_bloque',
    );
    expect(cerrarDecl).toBeDefined();
    expect(
      formatCollapsedThoughtLine(
        '\n  Primera línea real del pensamiento\nSegunda línea',
      ),
    ).toBe('Primera línea real del pensamiento');

    const session = new SessionState({
      ...DEFAULT_SETTINGS,
      permissionMode: 'always_ask', // Incluso en always_ask, cerrar_bloque no pide permiso
      subMode: 'plan', // Incluso en plan, cerrar_bloque responde "bloque cerrado"
    });

    let mainStep = 0;
    let summaryCallCount = 0;

    const adapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(
        history: readonly Content[],
        options: ProviderRequestOptions,
      ): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        const sys = options.systemInstruction ?? '';
        if (sys.includes('resumidor conciso de bloques de pensamiento')) {
          summaryCallCount++;
          if (summaryCallCount === 2) {
            // Simula fallo del resumidor en el segundo bloque (usa resumen determinista)
            throw new Error('Summarizer API error');
          }
          yield {
            text: 'Ocurrió el error 402, se inspeccionó el directorio y el intento fue exitoso.',
            usage: {
              inputTokens: 500,
              outputTokens: 30,
              cachedTokens: 0,
              reasoningTokens: 0,
              totalPromptTokens: 500,
            },
          };
          return;
        }

        mainStep++;
        // Bloque 1: cerrado explícitamente por el modelo con cerrar_bloque("error 402")
        if (mainStep === 1) {
          yield {
            text: 'Quiero listar la carpeta para localizar el módulo de login.',
            rawParts: [
              {
                text: 'Quiero listar la carpeta para localizar el módulo de login.',
              },
              {
                functionCall: {
                  id: 'fc-ls-b1',
                  name: 'list_directory',
                  args: { dir_path: tempHome },
                },
              },
            ],
          };
          return;
        }
        if (mainStep === 2) {
          yield {
            rawParts: [
              {
                functionCall: {
                  id: 'fc-close-b1',
                  name: 'cerrar_bloque',
                  args: { titulo: 'error 402' },
                },
              },
            ],
          };
          return;
        }

        // Bloque 2: 6 rondas seguidas de herramientas sin llamar a cerrar_bloque -> se cierra por respaldo al llegar a 6 y falla el resumidor -> resumen determinista
        if (mainStep >= 3 && mainStep <= 8) {
          if (mainStep === 3) {
            const closeResp = history.at(-1)?.parts?.[0]?.functionResponse
              ?.response as Record<string, unknown> | undefined;
            expect(closeResp?.['result']).toBe('bloque cerrado');
          }
          yield {
            text: `Quiero revisar el paso ${mainStep - 2}.`,
            rawParts: [
              { text: `Quiero revisar el paso ${mainStep - 2}.` },
              {
                functionCall: {
                  id: `fc-round-${mainStep}`,
                  name: 'list_directory',
                  args: { dir_path: tempHome },
                },
              },
            ],
          };
          return;
        }

        // Paso final: sin thoughts y sin texto -> no debe imprimir placeholder
        yield {
          rawParts: [],
        };
      },
    };

    const toolStartedNames: string[] = [];
    const subthinkingsSeen: string[] = [];
    const blockSummaries: ThinkingBlockSummaryEvent[] = [];
    const stepMsgs: string[] = [];

    await runSingleTurn({
      session,
      userPrompt: 'Resuelve el error 402 en bloques',
      getAdapter: () => adapter,
      customHomeDir: tempHome,
      onToolStart: (ev) => {
        toolStartedNames.push(ev.name);
        if (ev.subthinking) subthinkingsSeen.push(ev.subthinking);
      },
      onBlockSummary: (ev) => blockSummaries.push(ev),
      onStepMessage: (m) => stepMsgs.push(m.text),
    });

    // cerrar_bloque nunca se muestra como línea de herramienta en el chat
    expect(toolStartedNames).not.toContain('cerrar_bloque');
    expect(subthinkingsSeen[0]).toBe(
      'Quiero listar la carpeta para localizar el módulo de login.',
    );

    // Se cerraron 2 bloques: 1 por cerrar_bloque("error 402") y 1 por respaldo tras 6 rondas (con fallback determinista)
    expect(blockSummaries).toHaveLength(2);
    expect(blockSummaries[0]?.title).toBe('error 402');
    expect(blockSummaries[0]?.usedFallback).toBe(false);
    expect(blockSummaries[0]?.summary).toContain('intento fue exitoso');

    expect(blockSummaries[1]?.title).toBe('avance de herramientas');
    expect(blockSummaries[1]?.usedFallback).toBe(true);
    expect(blockSummaries[1]?.summary).toContain('list_directory');

    // Costo thinking_summary sumado al registro de costos
    expect(
      session.costRecords.some((r) => r.kind === 'thinking_summary'),
    ).toBe(true);

    // Sin placeholder "(sin respuesta de texto)" ni "Razonamiento ocultado" cuando no hay thoughts ni texto
    expect(stepMsgs.some((m) => m.includes('sin respuesta de texto'))).toBe(
      false,
    );
    expect(stepMsgs.some((m) => m.includes('Razonamiento ocultado'))).toBe(
      false,
    );
  });

  it('Paso 8: subagentes sin max_steps en herramientas, estado limite con continuar (c), bandeja de entrada, log por subagente, agrupación por ronda y filtrado de historial', async () => {
    // 1. Verifica que spawn_subagent y spawn_parallel_subagents ya no exponen max_steps ni mencionan "por defecto 25"
    const spawnDecl = GLITCH_TOOL_DECLARATIONS.find(
      (d) => d.name === 'spawn_subagent',
    )!;
    const spawnParDecl = GLITCH_TOOL_DECLARATIONS.find(
      (d) => d.name === 'spawn_parallel_subagents',
    )!;
    expect(
      JSON.stringify(spawnDecl.parameters).includes('max_steps'),
    ).toBe(false);
    expect(
      JSON.stringify(spawnParDecl.parameters).includes('max_steps'),
    ).toBe(false);
    expect(JSON.stringify(spawnDecl).includes('25')).toBe(false);

    // 2. Verifica estado "limite" al agotar subagentMaxSteps, log, bandeja de entrada y continuar con continueSubagentFromLimit
    let stepIdx = 0;
    const subAdapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(
        history: readonly Content[],
      ): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        stepIdx++;
        if (stepIdx <= 2) {
          yield {
            text: `Subthinking paso ${stepIdx}`,
            rawParts: [
              { text: `Subthinking paso ${stepIdx}` },
              {
                functionCall: {
                  id: `fc-sub-${stepIdx}`,
                  name: 'list_directory',
                  args: { dir_path: tempHome },
                },
              },
            ],
          };
          return;
        }
        const allTexts = history
          .flatMap((h) => (h.parts ?? []).map((p) => p.text ?? ''))
          .join('\n');
        yield {
          text: `Completado tras continuar. Historial incluye: ${allTexts.includes('Usa otra ruta') ? 'CORRECCION_OK' : 'SIN_CORRECCION'}`,
          rawParts: [
            {
              text: `Completado tras continuar. Historial incluye: ${allTexts.includes('Usa otra ruta') ? 'CORRECCION_OK' : 'SIN_CORRECCION'}`,
            },
          ],
        };
      },
    };

    const handle = startSubagentInBackground(
      {
        name: 'Limpieza de logs',
        task: 'Limpiar archivos temporales',
        round: 2,
      },
      {
        getAdapter: () => subAdapter,
        model: 'gemini-4-argon',
        effort: 'medium',
        includeThoughts: true,
        parentSubMode: 'agent',
        permissionMode: 'always_allow',
        availableSkills: [],
        subagentMaxSteps: 2,
        round: 2,
      },
    );

    sendSubagentCorrection(handle.id, 'Usa otra ruta');
    const firstRes = await handle.promise;

    expect(firstRes.status).toBe('limite');
    expect(handle.info.status).toBe('limite');
    expect(handle.info.currentAction).toBe('(se pidió parar a 2)');
    expect(formatSubagentOutcomeForModel(firstRes)).toContain('LIMITE');
    expect(handle.info.log.some((e) => e.kind === 'subthinking')).toBe(true);
    expect(handle.info.log.some((e) => e.kind === 'tool_call')).toBe(true);
    expect(handle.info.log.some((e) => e.kind === 'correction')).toBe(true);

    // Continuar subagente en estado limite (tecla 'c')
    const continuedPromise = continueSubagentFromLimit(handle.id, 3);
    expect(continuedPromise).not.toBeNull();
    const secondRes = await continuedPromise!;
    expect(secondRes.status).toBe('completed');
    expect(secondRes.output).toContain('CORRECCION_OK');

    // 3. Agrupación por ronda y truncado uniforme con "…"
    const grouped = groupSubagentsByRound([
      { ...handle.info, id: 's1', round: 2 },
      { ...handle.info, id: 's2', round: 1 },
    ]);
    expect(grouped.map((g) => g.round)).toEqual([1, 2]);

    const colW = computeAgentsTableColumnWidths(100);
    const truncName = truncateAndPadColumn(
      'Nombre de subagente extremadamente largo que debe truncarse con elipsis',
      colW.nameWidth,
    );
    expect(truncName.length).toBe(colW.nameWidth);
    expect(truncName.trimEnd().endsWith('…')).toBe(true);

    // 4. Historial en el panel: turnos reales, limpieza de [clipboard-...] y ocultación de sesiones <= 2 turnos
    expect(
      cleanSessionTitle('Arregla este bug [clipboard-123.png] [captura.png]'),
    ).toBe('Arregla este bug');

    const sShort = {
      id: 's-short',
      title: 'Hola',
      createdAt: '2026-10-25 10:00:00',
      updatedAt: '2026-10-25 10:01:00',
      model: 'gemini-4-argon',
      effort: 'medium',
      // Simula muchos turnos internos de herramientas pero solo 1 mensaje real del usuario
      history: [
        { role: 'user' as const, parts: [{ text: 'Hola' }] },
        {
          role: 'model' as const,
          parts: [{ functionCall: { name: 'list_directory', args: {} } }],
        },
        {
          role: 'user' as const,
          parts: [{ functionResponse: { name: 'list_directory', response: {} } }],
        },
        { role: 'model' as const, parts: [{ text: 'Listo' }] },
      ],
      messages: [],
    };
    expect(countRealUserTurns(sShort)).toBe(1);

    const sLong = {
      ...sShort,
      id: 's-long',
      title: 'Sesión de 3 turnos reales',
      history: [
        { role: 'user' as const, parts: [{ text: 'Turno 1' }] },
        { role: 'model' as const, parts: [{ text: 'Resp 1' }] },
        { role: 'user' as const, parts: [{ text: 'Turno 2' }] },
        { role: 'model' as const, parts: [{ text: 'Resp 2' }] },
        { role: 'user' as const, parts: [{ text: 'Turno 3' }] },
        { role: 'model' as const, parts: [{ text: 'Resp 3' }] },
      ],
    };
    expect(countRealUserTurns(sLong)).toBe(3);

    const filteredDefault = filterSavedSessionsForPanel(
      [sShort, sLong],
      'other-current-id',
      false,
    );
    expect(filteredDefault.visibleSessions.map((s) => s.id)).toEqual(['s-long']);
    expect(filteredDefault.hiddenShortCount).toBe(1);
    expect(filteredDefault.showToggleAllOption).toBe(true);

    const filteredAll = filterSavedSessionsForPanel(
      [sShort, sLong],
      'other-current-id',
      true,
    );
    expect(filteredAll.visibleSessions.map((s) => s.id)).toEqual([
      's-short',
      's-long',
    ]);
  });

  it('genera título resumido con gemini-3.1-pro-preview en el 1er mensaje con tema y al 5to mensaje completo (ignorando cancelados)', async () => {
    expect(isBareGreetingMessage('hola')).toBe(true);
    expect(isBareGreetingMessage('hola vamos a crear una app con html')).toBe(
      false,
    );
    expect(
      buildFallbackTopicTitle('hola vamos a crear una app con html'),
    ).toBe('Creación de app con HTML');

    // Mientras tanto usa el primer mensaje si aún no hay customTitle
    const initialMsgs = [
      { id: 'u1', role: 'user' as const, text: 'hola' },
      { id: 'm1', role: 'model' as const, text: '¡Hola! ¿En qué te ayudo?' },
    ];
    expect(deriveSessionTitle(initialMsgs, [])).toBe('hola');

    // Conteo de mensajes completos: ignora turnos donde el usuario canceló con ESC
    const mixedMsgs = [
      { id: 'u1', role: 'user' as const, text: 'hola vamos a crear una app con html' },
      { id: 'm1', role: 'model' as const, text: 'Claro, creemos la estructura HTML.' },
      { id: 'u2', role: 'user' as const, text: 'agrega estilos' },
      {
        id: 't2',
        role: 'system' as const,
        text: 'escribir(styles.css) - cancelado',
        toolStatus: 'cancelado' as const,
      },
      { id: 'u3', role: 'user' as const, text: 'agrega formulario de login' },
      { id: 'm3', role: 'model' as const, text: 'Formulario agregado.' },
    ];
    expect(countCompletedConversationTurns(mixedMsgs)).toBe(2);

    const calledModels: string[] = [];
    const fakeAdapter: ProviderAdapter = {
      name: 'fake',
      async *streamTurn(_contents, options) {
        calledModels.push(options.model);
        yield { text: 'Creación de app con HTML', isThought: false };
      },
    };

    const titleTurn1 = await generateSessionSummaryTitle({
      messages: mixedMsgs.slice(0, 2),
      history: [],
      adapter: fakeAdapter,
    });
    expect(calledModels).toEqual(['gemini-3.1-pro-preview']);
    expect(titleTurn1).toBe('Creación de app con HTML');
    expect(deriveSessionTitle(mixedMsgs, [], titleTurn1 ?? undefined)).toBe(
      'Creación de app con HTML',
    );
  });

  it('evita duplicar subthinking entre onStepMessage y múltiples herramientas paralelas del mismo paso', async () => {
    const session = new SessionState({
      ...DEFAULT_SETTINGS,
      permissionMode: 'always_allow',
      subMode: 'agent',
    });

    let step = 0;
    const adapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        step++;
        if (step === 1) {
          const subText =
            'Quiero revisar `.gitignore` y `package.json` al mismo tiempo.';
          yield {
            text: subText,
            rawParts: [
              { text: subText },
              {
                functionCall: {
                  id: 'fc-par-1',
                  name: 'list_directory',
                  args: { dir_path: tempHome },
                },
              },
              {
                functionCall: {
                  id: 'fc-par-2',
                  name: 'list_directory',
                  args: { dir_path: tempHome },
                },
              },
            ],
          };
          return;
        }
        yield {
          text: 'Revisión completada.',
          rawParts: [{ text: 'Revisión completada.' }],
        };
      },
    };

    const stepMessages: TurnStepMessageEvent[] = [];
    const toolStarts: TurnToolStartEvent[] = [];

    await runSingleTurn({
      session,
      userPrompt: 'Revisa los archivos sin duplicar pensamientos',
      getAdapter: () => adapter,
      customHomeDir: tempHome,
      onStepMessage: (m) => stepMessages.push(m),
      onToolStart: (ev) => toolStarts.push(ev),
    });

    // En el paso 1 con herramientas visibles, no debe emitirse un stepMessage con el texto de subthinking duplicado
    expect(stepMessages).toHaveLength(1);
    expect(stepMessages[0]?.text).toBe('Revisión completada.');
    expect(stepMessages[0]?.isFinal).toBe(true);

    // En el lote paralelo de 2 herramientas, solo la primera lleva subthinking y la segunda no lo repite
    expect(toolStarts).toHaveLength(2);
    expect(toolStarts[0]?.subthinking).toBe(
      'Quiero revisar `.gitignore` y `package.json` al mismo tiempo.',
    );
    expect(toolStarts[1]?.subthinking).toBeUndefined();
  });

  it('inyecta nota con /btw (injectBtwThoughtNote) en la cadena de pensamiento en vivo sin abortar ni frenar el paso actual', async () => {
    const session = new SessionState({
      ...DEFAULT_SETTINGS,
      permissionMode: 'always_allow',
      subMode: 'agent',
    });
    const stepControllerRef: TurnStepControllerRef = {
      interruptCurrentStepForCorrection: () => {},
    };

    let step = 0;
    let step1WasAborted = false;
    let step2SawBtwInHistory = false;
    let step2SawBtwInSystemInstruction = false;

    const adapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(
        history: readonly Content[],
        options: ProviderRequestOptions,
      ): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        step++;
        if (step === 1) {
          yield { thoughtText: 'Analizando archivos del proyecto...' };
          // El usuario lanza /btw a mitad del thinking del paso 1
          stepControllerRef.injectBtwThoughtNote?.(
            'pero recuerda que no debes tocar .git',
          );
          step1WasAborted = Boolean(options.abortSignal?.aborted);
          yield {
            text: 'Quiero listar el directorio.',
            rawParts: [
              { text: 'Quiero listar el directorio.' },
              {
                functionCall: {
                  id: 'fc-btw-1',
                  name: 'list_directory',
                  args: { dir_path: tempHome },
                },
              },
            ],
          };
          return;
        }

        const serializedHistory = JSON.stringify(history);
        step2SawBtwInHistory = serializedHistory.includes(
          'pero recuerda que no debes tocar .git',
        );
        step2SawBtwInSystemInstruction = Boolean(
          options.systemInstruction?.includes(
            'pero recuerda que no debes tocar .git',
          ),
        );
        yield {
          text: 'Entendido, completado sin tocar .git.',
          rawParts: [{ text: 'Entendido, completado sin tocar .git.' }],
        };
      },
    };

    const res = await runSingleTurn({
      session,
      userPrompt: 'Limpia el proyecto',
      getAdapter: () => adapter,
      stepControllerRef,
      customHomeDir: tempHome,
    });

    expect(step1WasAborted).toBe(false);
    expect(step2SawBtwInHistory).toBe(true);
    expect(step2SawBtwInSystemInstruction).toBe(true);
    expect(res.finalText).toBe('Entendido, completado sin tocar .git.');
  });
});
