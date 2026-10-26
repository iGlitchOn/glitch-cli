import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThinkingLevel, type GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCAL_GOOGLE_MODELS,
  buildVertexThinkingConfig,
  formatHumanModelName,
  formatModelRowColumns,
  getModelDefinition,
  groupModelsByFamilyPages,
  isGoogleFreeTrialModelId,
  listVertexGoogleModels,
  sortModelsByDateDesc,
} from '../config/models.js';
import { DEFAULT_SETTINGS, type GlitchSettings } from '../config/settings.js';
import { runModelCommand } from '../commands/model.js';
import { runEffortCommand } from '../commands/effort.js';
import {
  formatInputTopLeftMode,
  formatInputTopRightInfo,
  formatStatusBar,
} from '../ui/statusBar.js';

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

  it('usa el registro local models.ts ordenado por fecha descendente si la API de listado falla', async () => {
    const failingAi = {
      models: {
        list: async () => {
          throw new Error('Network error');
        },
      },
    } as unknown as GoogleGenAI;

    const models = await listVertexGoogleModels(failingAi);
    expect(models).toEqual(sortModelsByDateDesc(LOCAL_GOOGLE_MODELS));
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

    runEffortCommand(baseSettings, '', (m) => logs.push(m), tempHome);
    expect(logs.at(-1)).toContain('MEDIUM');
    expect(logs.at(-1)).toContain('LOW, MEDIUM, HIGH');

    const afterMinimal = runEffortCommand(
      baseSettings,
      'minimal',
      (m) => logs.push(m),
      tempHome,
    );
    expect(afterMinimal.effort).toBe('medium');
    expect(logs.at(-1)).toContain('MINIMAL y thinking_budget no están permitidos');

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

    const gemini25Settings: GlitchSettings = {
      ...baseSettings,
      model: 'gemini-2.5-pro',
    };
    runEffortCommand(gemini25Settings, 'high', (m) => logs.push(m), tempHome);
    expect(logs.at(-1)).toContain('no aplica');
  });

  it('/model rechaza cambios durante una petición activa y ajusta el effort al cambiar de modelo', async () => {
    const logs: string[] = [];

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

    const withEffortArg = await runModelCommand(
      { ...baseSettings, model: 'gemini-2.5-pro', effort: 'low' },
      LOCAL_GOOGLE_MODELS,
      false,
      'gemini-4-argon high',
      async () => '',
      (m) => logs.push(m),
      tempHome,
    );
    expect(withEffortArg.model).toBe('gemini-4-argon');
    expect(withEffortArg.effort).toBe('high');
  });

  it('renderiza la barra inferior con el nombre físico del modelo y Esfuerzo, y la barra superior del chat con Modo/Sub-Modo y % de contexto/MCP/skills', () => {
    const bar = formatStatusBar(baseSettings);
    expect(bar).toBe('Modelo: Gemini 4 Argon | Esfuerzo: MEDIUM');

    const topLeft = formatInputTopLeftMode({
      ...baseSettings,
      subMode: 'plan',
    });
    expect(topLeft).toBe('Always Allow · Sub-Modo: Plan (Shift+Tab)');

    const topRight = formatInputTopRightInfo([], 3, 73);
    expect(topRight).toBe('100% contexto restante · 3 MCP activos · 73 skills');

    const noEffortBar = formatStatusBar({
      ...baseSettings,
      model: 'gemma-3-27b-it',
      subMode: 'plan',
    });
    expect(noEffortBar).toBe('Modelo: Gemma 3 27B IT | Esfuerzo: N/A');
  });

  it('separa los modelos en páginas limpias (Gemini, Gemma, Nano Banana, Embeddings), ordenados por fecha descendente y formatea NOMBRE (active) | ID | FECHA | ESFUERZO (LOW - MEDIUM - HIGH)', () => {
    const pages = groupModelsByFamilyPages(LOCAL_GOOGLE_MODELS);
    expect(pages.map((p) => p.family)).toEqual([
      'gemini',
      'gemma',
      'nano-banana',
      'embeddings',
    ]);

    // En la página 1 (Gemini), el más reciente (2026-04-15 Argon) está arriba y el más antiguo (2025-02-05) abajo, sin embeddings ni imagen mezclados
    const geminiPage = pages[0]!;
    expect(geminiPage.title).toBe('Gemini');
    expect(geminiPage.models[0]?.releaseDate).toBe('2026-04-15');
    expect(geminiPage.models.at(-1)?.releaseDate).toBe('2025-02-05');
    expect(
      geminiPage.models.some(
        (m) =>
          m.id.includes('embedding') ||
          m.id.includes('image') ||
          m.id.includes('transcribe'),
      ),
    ).toBe(false);

    // Verifica que modelos dinámicos nunca tengan el ID crudo como nombre y que transcribe se separe
    expect(formatHumanModelName('gemini-3.5-flash-lite')).toBe(
      'Gemini 3.5 Flash-Lite',
    );
    expect(formatHumanModelName('gemini-2.5-flash-preview-04-17')).toBe(
      'Gemini 2.5 Flash Preview (04-17)',
    );
    expect(formatHumanModelName('gemini-1.5-pro-002')).toBe(
      'Gemini 1.5 Pro 002',
    );
    expect(formatHumanModelName('gemini-omni-1.1-flash-preview')).toBe(
      'Gemini Omni 1.1 Flash Preview',
    );

    const transcribeDef = getModelDefinition('gemini-3.5-transcribe', 'vertex');
    expect(transcribeDef.family).toBe('media-live');
    expect(transcribeDef.name).toBe('Gemini 3.5 Transcribe');
    expect(transcribeDef.supportedEfforts).toEqual([]);

    const argonModel = LOCAL_GOOGLE_MODELS.find(
      (m) => m.id === 'gemini-4-argon',
    )!;
    const activeRow = formatModelRowColumns(argonModel, true);
    expect(activeRow.nameCol).toContain('Gemini 4 Argon (active)');
    expect(activeRow.idCol.trim()).toBe('gemini-4-argon');
    expect(activeRow.dateCol.trim()).toBe('2026-04-15');
    expect(activeRow.effortsCol).toBe('LOW - MEDIUM - HIGH');
    expect(activeRow.formatted).toContain(
      '| gemini-4-argon                   | 2026-04-15 | LOW - MEDIUM - HIGH',
    );
  });
});
