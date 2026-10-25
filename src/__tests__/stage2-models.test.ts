import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThinkingLevel, type GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCAL_GOOGLE_MODELS,
  buildVertexThinkingConfig,
  isGoogleFreeTrialModelId,
  listVertexGoogleModels,
} from '../config/models.js';
import { DEFAULT_SETTINGS, type GlitchSettings } from '../config/settings.js';
import { runModelCommand } from '../commands/model.js';
import { runEffortCommand } from '../commands/effort.js';
import { formatStatusBar } from '../ui/statusBar.js';

describe('Etapa 2: Modelos, /model, /effort y barra de estado', () => {
  let tempHome: string;
  let baseSettings: GlitchSettings;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glitch-stage2-'));
    baseSettings = {
      ...DEFAULT_SETTINGS,
      provider: 'vertex',
      vertex: { project: 'test-proj', location: 'us-central1' },
      model: 'gemini-4-argon',
      effort: 'medium',
    };
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('filtra modelos de socios (Claude/Llama/Mistral) y conserva solo Gemini y Gemma', async () => {
    expect(isGoogleFreeTrialModelId('publishers/google/models/gemini-2.5-pro')).toBe(true);
    expect(isGoogleFreeTrialModelId('publishers/google/models/gemma-3-27b-it')).toBe(true);
    expect(isGoogleFreeTrialModelId('publishers/anthropic/models/claude-3-7-sonnet')).toBe(false);
    expect(isGoogleFreeTrialModelId('publishers/meta/models/llama-3.3-70b')).toBe(false);

    const fakeAi = {
      models: {
        list: async () =>
          (async function* () {
            yield { name: 'publishers/google/models/gemini-2.5-pro' };
            yield { name: 'publishers/anthropic/models/claude-3-5-sonnet' };
            yield { name: 'publishers/google/models/gemma-3-27b-it' };
          })(),
      },
    } as unknown as GoogleGenAI;

    const models = await listVertexGoogleModels(fakeAi);
    const ids = models.map((m) => m.id);
    expect(ids).toContain('gemini-4-argon');
    expect(ids).toContain('gemini-4-argon-cyber-permissive');
    expect(ids).toContain('gemini-2.5-pro');
    expect(ids).toContain('gemma-3-27b-it');
    expect(ids.some((id) => id.includes('claude'))).toBe(false);
  });

  it('usa el registro local models.ts si la API de listado falla', async () => {
    const failingAi = {
      models: {
        list: async () => {
          throw new Error('Network error');
        },
      },
    } as unknown as GoogleGenAI;

    const models = await listVertexGoogleModels(failingAi);
    expect(models).toEqual(LOCAL_GOOGLE_MODELS);
  });

  it('configura thinkingLevel en Argon sin enviar jamás thinkingBudget ni MINIMAL', () => {
    const argonCfg = buildVertexThinkingConfig('gemini-4-argon', 'low', true);
    expect(argonCfg).toEqual({
      includeThoughts: true,
      thinkingLevel: ThinkingLevel.LOW,
    });
    expect(argonCfg).not.toHaveProperty('thinkingBudget');

    const cyberCfg = buildVertexThinkingConfig(
      'gemini-4-argon-cyber-permissive',
      'low',
      true,
    );
    expect(cyberCfg).toEqual({
      includeThoughts: true,
      thinkingLevel: ThinkingLevel.HIGH,
    });
    expect(cyberCfg).not.toHaveProperty('thinkingBudget');
  });

  it('/effort valida niveles por modelo y dice que no aplica cuando no soporta thinkingLevel', () => {
    const logs: string[] = [];

    // Sin argumento muestra el actual y permitidos
    runEffortCommand(baseSettings, '', (m) => logs.push(m), tempHome);
    expect(logs.at(-1)).toContain('MEDIUM');
    expect(logs.at(-1)).toContain('LOW, MEDIUM, HIGH');

    // Rechaza MINIMAL y thinking_budget
    const afterMinimal = runEffortCommand(
      baseSettings,
      'minimal',
      (m) => logs.push(m),
      tempHome,
    );
    expect(afterMinimal.effort).toBe('medium');
    expect(logs.at(-1)).toContain('MINIMAL y thinking_budget no están permitidos');

    // En gemini-4-argon-cyber-permissive solo permite HIGH
    const cyberSettings: GlitchSettings = {
      ...baseSettings,
      model: 'gemini-4-argon-cyber-permissive',
      effort: 'high',
    };
    const afterLowOnCyber = runEffortCommand(
      cyberSettings,
      'low',
      (m) => logs.push(m),
      tempHome,
    );
    expect(afterLowOnCyber.effort).toBe('high');
    expect(logs.at(-1)).toContain('Niveles permitidos: high');

    // En gemini-2.5-pro o gemma dice que no aplica
    const gemini25Settings: GlitchSettings = {
      ...baseSettings,
      model: 'gemini-2.5-pro',
    };
    runEffortCommand(gemini25Settings, 'high', (m) => logs.push(m), tempHome);
    expect(logs.at(-1)).toContain('no aplica');
  });

  it('/model rechaza cambios durante una petición activa y ajusta el effort al cambiar de modelo', async () => {
    const logs: string[] = [];

    // Bloqueado si hay petición activa
    const blocked = await runModelCommand(
      baseSettings,
      LOCAL_GOOGLE_MODELS,
      true,
      'gemini-2.5-pro',
      async () => '',
      (m) => logs.push(m),
      tempHome,
    );
    expect(blocked.model).toBe('gemini-4-argon');
    expect(logs.at(-1)).toContain('petición activa');

    // Cambio a gemini-4-argon-cyber-permissive ajusta effort de 'low' a 'high'
    const lowArgon: GlitchSettings = { ...baseSettings, effort: 'low' };
    const switched = await runModelCommand(
      lowArgon,
      LOCAL_GOOGLE_MODELS,
      false,
      'gemini-4-argon-cyber-permissive',
      async () => '',
      (m) => logs.push(m),
      tempHome,
    );
    expect(switched.model).toBe('gemini-4-argon-cyber-permissive');
    expect(switched.effort).toBe('high');
  });

  it('renderiza la barra de estado con modelo, effort, modo y sub-modo', () => {
    const bar = formatStatusBar(baseSettings);
    expect(bar).toBe(
      '[Modelo: gemini-4-argon | Effort: MEDIUM | Modo: Ask only insecure | Sub-modo: Agent]',
    );

    const noEffortBar = formatStatusBar({
      ...baseSettings,
      model: 'gemma-3-27b-it',
    });
    expect(noEffortBar).toBe(
      '[Modelo: gemma-3-27b-it | Effort: N/A | Modo: Ask only insecure | Sub-modo: Agent]',
    );
  });
});
