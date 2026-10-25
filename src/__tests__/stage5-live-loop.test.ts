import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Content } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../config/settings.js';
import { AgentLoop } from '../core/agentLoop.js';
import { handleUserInputLine } from '../core/inputLoop.js';
import { SessionState } from '../core/session.js';
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
});
