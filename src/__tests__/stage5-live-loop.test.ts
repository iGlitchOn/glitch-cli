import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Content } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../config/settings.js';
import {
  matchSlashCommands,
  resolveSlashCommandAlias,
} from '../commands/slashRegistry.js';
import { AgentLoop } from '../core/agentLoop.js';
import { handleUserInputLine } from '../core/inputLoop.js';
import { SessionState } from '../core/session.js';
import {
  listSavedSessions,
  saveSessionToDisk,
} from '../core/sessionStore.js';
import type {
  ProviderAdapter,
  ProviderRequestOptions,
  ProviderStreamChunk,
} from '../providers/types.js';

describe('Etapa 5: Slash commands en vivo con AgentLoop separado del InputLoop', () => {
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

    // Tarea con 2 llamadas al modelo (ej. paso 1 y paso 2 dentro de la misma tarea)
    const agentLoop = new AgentLoop(
      session,
      () => fakeAdapter,
      (t) => streamed.push(t),
      (e) => logs.push(e),
      {
        shouldContinueTask: (stepIndex) => stepIndex < 2,
      },
    );

    // 1. El usuario envía una tarea normal (inicia con effort = 'high')
    const dispatchResult = await handleUserInputLine(
      'Analiza el sistema en dos pasos',
      {
        session,
        agentLoop,
        ask: async () => '',
        out: (m) => logs.push(m),
        customHomeDir: tempHome,
      },
    );

    expect(dispatchResult.handledAsSlash).toBe(false);
    await firstCallStarted;
    expect(session.isRequestActive).toBe(true);

    // 2. Mientras la petición está activa, el usuario intenta /model (se rechaza sin romper la tarea)
    await handleUserInputLine('/model gemini-2.5-pro', {
      session,
      agentLoop,
      ask: async () => '',
      out: (m) => logs.push(m),
      customHomeDir: tempHome,
    });
    expect(session.settings.model).toBe('gemini-4-argon');
    expect(logs.some((l) => l.includes('petición activa'))).toBe(true);

    // 3. Mientras la petición sigue activa en el paso 1 (high), el usuario ejecuta /effort low en vivo
    const slashEffort = await handleUserInputLine('/effort low', {
      session,
      agentLoop,
      ask: async () => '',
      out: (m) => logs.push(m),
      customHomeDir: tempHome,
    });
    expect(slashEffort.handledAsSlash).toBe(true);
    expect(session.settings.effort).toBe('low');

    // 4. Termina la primera llamada y el AgentLoop lanza la segunda llamada de la MISMA tarea
    allowFirstCallToFinish();
    await dispatchResult.queuedTask;

    expect(session.isRequestActive).toBe(false);
    expect(agentLoop.recordedCallConfigs).toHaveLength(2);
    expect(agentLoop.recordedCallConfigs[0]?.effort).toBe('high');
    expect(agentLoop.recordedCallConfigs[1]?.effort).toBe('low');
    expect(streamed).toEqual(['paso-1-high', 'paso-2-low']);

    // Verifica que ningún slash command se haya enviado al historial del modelo como texto
    const allHistoryTexts = session.history.flatMap((h) =>
      (h.parts ?? []).map((p) => p.text ?? ''),
    );
    expect(allHistoryTexts.some((t) => t.startsWith('/'))).toBe(false);
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

    const agentLoop = new AgentLoop(session, () => fakeAdapter, () => {});

    // Inicia una tarea activa y luego encola 3 prompts más en fila
    const activePromise = agentLoop.enqueuePrompt('Tarea inicial corriendo');
    await firstCallStarted;

    void agentLoop.enqueuePrompt('Prompt en cola 1');
    void agentLoop.enqueuePrompt('Prompt en cola 2 (original)');
    void agentLoop.enqueuePrompt('Prompt en cola 3');

    expect(agentLoop.getQueuedPrompts()).toEqual([
      'Prompt en cola 1',
      'Prompt en cola 2 (original)',
      'Prompt en cola 3',
    ]);

    // Si hay 3 en cola y el usuario sube 2 veces (↑ ↑), accede al segundo prompt (índice 1) sin tocar el tercero
    const targetIdx = agentLoop.getQueueIndexFromStepsUp(2);
    expect(targetIdx).toBe(1);
    const updatedOk = agentLoop.updateQueuedPromptAt(
      targetIdx,
      'Prompt en cola 2 (EDITADO)',
    );
    expect(updatedOk).toBe(true);
    expect(agentLoop.getQueuedPrompts()).toEqual([
      'Prompt en cola 1',
      'Prompt en cola 2 (EDITADO)',
      'Prompt en cola 3',
    ]);

    allowFirstCallToFinish();
    await activePromise;

    expect(receivedUserPrompts).toEqual([
      'Tarea inicial corriendo',
      'Prompt en cola 1',
      'Prompt en cola 2 (EDITADO)',
      'Prompt en cola 3',
    ]);
  });

  it('mapea alternativas (/cl, /clear -> /new y /continue -> /resume) y ejecuta /new y /resume correctamente', async () => {
    // Al buscar /cl o /clear aparece el comando original /new
    const matchesCl = matchSlashCommands('/cl');
    expect(matchesCl[0]?.cmd).toBe('/new');
    const matchesClear = matchSlashCommands('/clear');
    expect(matchesClear[0]?.cmd).toBe('/new');
    expect(resolveSlashCommandAlias('/clear')).toBe('/new');
    expect(resolveSlashCommandAlias('/continue 1')).toBe('/resume 1');

    const session = new SessionState({ ...DEFAULT_SETTINGS });
    const fakeAdapter: ProviderAdapter = {
      id: 'vertex',
      async *streamTurn(): AsyncGenerator<ProviderStreamChunk, void, unknown> {
        yield { text: 'ok' };
      },
    };
    const agentLoop = new AgentLoop(session, () => fakeAdapter, () => {});
    const logs: string[] = [];

    // Guarda una sesión previa en disco para probar /resume
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

    expect(listSavedSessions(tempHome)).toHaveLength(1);

    // Retoma la sesión 1 usando /resume 1
    await handleUserInputLine('/resume 1', {
      session,
      agentLoop,
      ask: async () => '',
      out: (m) => logs.push(m),
      customHomeDir: tempHome,
    });
    expect(session.history).toHaveLength(2);

    // Limpia la conversación usando el alias /clear (que resuelve a /new)
    await handleUserInputLine('/clear', {
      session,
      agentLoop,
      ask: async () => '',
      out: (m) => logs.push(m),
      customHomeDir: tempHome,
    });
    expect(session.history).toHaveLength(0);
    expect(logs.at(-1)).toContain('/new');
  });
});
