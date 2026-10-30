import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  formatPermissionModeLabel,
  getSettingsPath,
  hasAlwaysAllowFlag,
  hasSameWindowFlag,
  loadSettings,
  notifyUnchanged,
  parseMessageFlag,
  parseModelFlag,
  saveSettings,
  validateAutoCompactThreshold,
  type GlitchSettings,
} from '../config/settings.js';
import {
  executeGlitchToolCallAsync,
  parseGlitchWindowShellCommand,
  spawnGlitchTerminalWindow,
} from '../core/tools.js';
import { LOCAL_GOOGLE_MODELS } from '../config/models.js';
import { runEffortCommand } from '../commands/effort.js';
import { runModelCommand } from '../commands/model.js';
import {
  checkPermission,
  classifyActionRisk,
  toggleSubMode,
} from '../permissions/permissions.js';
import {
  applySettingOptionValue,
  getSettingHelpDetail,
  runSettingsCommand,
} from '../commands/settings.js';

describe('Etapa 3: Modos de permiso, checkPermission, Sub-modos (Plan/Agent) y /settings', () => {
  let tempHome: string;
  let baseSettings: GlitchSettings;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glitch-stage3-'));
    baseSettings = { ...DEFAULT_SETTINGS };
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('usa Always Allow por defecto y soporta flags --DAA, --dangerously-always-allow, --model y -m', () => {
    expect(DEFAULT_SETTINGS.permissionMode).toBe('always_allow');
    expect(formatPermissionModeLabel('always_allow')).toBe('Always Allow');
    expect(hasAlwaysAllowFlag(['--DAA'])).toBe(true);
    expect(hasAlwaysAllowFlag(['--DDA'])).toBe(true);
    expect(hasAlwaysAllowFlag(['--dangerously-always-allow'])).toBe(true);
    expect(hasAlwaysAllowFlag(['--version'])).toBe(false);

    expect(parseModelFlag(['--model', 'gemini-2.5-flash'])).toBe(
      'gemini-2.5-flash',
    );
    expect(parseModelFlag(['-m', 'gemini-2.5-flash'])).toBe('gemini-2.5-flash');

    saveSettings({ ...baseSettings, permissionMode: 'always_ask' }, tempHome);
    const loadedWithFlags = loadSettings(tempHome, [
      '--DAA',
      '-m',
      'gemini-2.5-flash',
    ]);
    expect(loadedWithFlags.permissionMode).toBe('always_allow');
    expect(loadedWithFlags.model).toBe('gemini-2.5-flash');
  });

  it('clasifica acciones en safe e insecure correctamente', () => {
    expect(classifyActionRisk('read_file')).toBe('safe');
    expect(classifyActionRisk('list_directory')).toBe('safe');
    expect(classifyActionRisk('grep_search')).toBe('safe');
    expect(classifyActionRisk('write_file')).toBe('insecure');
    expect(classifyActionRisk('exec_shell')).toBe('insecure');
    expect(classifyActionRisk('delete_file')).toBe('insecure');
  });

  it('evalúa checkPermission para Always Allow, Ask only insecure y Always Ask en sub-modo Agent', () => {
    expect(checkPermission('read_file', 'always_allow', 'agent').decision).toBe(
      'allow',
    );
    expect(
      checkPermission('write_file', 'always_allow', 'agent').decision,
    ).toBe('allow');

    expect(checkPermission('read_file', 'ask_insecure', 'agent').decision).toBe(
      'allow',
    );
    expect(
      checkPermission('write_file', 'ask_insecure', 'agent').decision,
    ).toBe('ask');

    expect(checkPermission('read_file', 'always_ask', 'agent').decision).toBe(
      'ask',
    );
    expect(checkPermission('write_file', 'always_ask', 'agent').decision).toBe(
      'ask',
    );
  });

  it('bloquea cualquier acción que modifique estado cuando el sub-modo es Plan', () => {
    const safeInPlan = checkPermission('read_file', 'always_allow', 'plan');
    expect(safeInPlan.decision).toBe('allow');

    const modifyInPlan = checkPermission('write_file', 'always_allow', 'plan');
    expect(modifyInPlan.decision).toBe('deny');
    expect(modifyInPlan.reason).toContain('Sub-modo Plan activo');
  });

  it('alterna entre Plan y Agent con toggleSubMode y persiste cambios desde /settings', async () => {
    expect(toggleSubMode('agent')).toBe('plan');
    expect(toggleSubMode('plan')).toBe('agent');

    const logs: string[] = [];

    // Sin cambios conserva Always Allow por defecto
    let updated = await runSettingsCommand(
      baseSettings,
      async () => '',
      (m) => logs.push(m),
      tempHome,
    );
    expect(updated.permissionMode).toBe('always_allow');

    // Cambiar modo de permisos a Ask only insecure (opción 1 -> 2)
    let step = 0;
    const answersMode = ['1', '2'];
    updated = await runSettingsCommand(
      baseSettings,
      async () => answersMode[step++] ?? '',
      (m) => logs.push(m),
      tempHome,
    );
    expect(updated.permissionMode).toBe('ask_insecure');

    // Cambiar sub-modo a Plan (opción 2 -> 1)
    step = 0;
    const answersSubMode = ['2', '1'];
    updated = await runSettingsCommand(
      updated,
      async () => answersSubMode[step++] ?? '',
      (m) => logs.push(m),
      tempHome,
    );
    expect(updated.subMode).toBe('plan');

    // Cambiar thoughts a OFF (opción 4 -> off)
    step = 0;
    const answersThoughts = ['4', 'off'];
    updated = await runSettingsCommand(
      updated,
      async () => answersThoughts[step++] ?? '',
      (m) => logs.push(m),
      tempHome,
    );
    expect(updated.thoughts).toBe(false);

    const persisted = loadSettings(tempHome);
    expect(persisted.permissionMode).toBe('ask_insecure');
    expect(persisted.subMode).toBe('plan');
    expect(persisted.thoughts).toBe(false);

    // Verifica la segunda TUI explicativa contextual en /settings (/ajustes)
    const daaHelpEs = getSettingHelpDetail(4);
    expect(daaHelpEs.availableModesLabel).toBe('Modos disponibles:');
    expect(daaHelpEs.availableModes).toContain('Activa');
    expect(daaHelpEs.whatItDoesLabel).toBe('¿Qué hace?');
    expect(daaHelpEs.whatItDoes).toContain('--dangerously-always-allow');

    // Verifica la opción 6 en /settings para Preguntas de la IA (ask_user): ON / OFF (modo ausente / AFK)
    expect(DEFAULT_SETTINGS.allowAgentQuestions).toBe(true);
    step = 0;
    const answersAskUserOff = ['6', 'off'];
    updated = await runSettingsCommand(
      updated,
      async () => answersAskUserOff[step++] ?? '',
      (m) => logs.push(m),
      tempHome,
    );
    expect(updated.allowAgentQuestions).toBe(false);

    const askUserHelpEs = getSettingHelpDetail(5);
    expect(askUserHelpEs.title).toContain('Preguntas de la IA (ask_user)');
    expect(askUserHelpEs.whatItDoes).toContain('AFK');

    // Verifica Autocompactación (por defecto ON) y Umbral de autocompactación (por defecto 70, rango entero 10..95)
    expect(DEFAULT_SETTINGS.autoCompact).toBe(true);
    expect(DEFAULT_SETTINGS.autoCompactThreshold).toBe(70);

    expect(validateAutoCompactThreshold('70')).toEqual({
      valid: true,
      value: 70,
    });
    expect(validateAutoCompactThreshold('10')).toEqual({
      valid: true,
      value: 10,
    });
    expect(validateAutoCompactThreshold('95')).toEqual({
      valid: true,
      value: 95,
    });
    expect(validateAutoCompactThreshold('70.5').valid).toBe(false);
    expect(validateAutoCompactThreshold('9').valid).toBe(false);
    expect(validateAutoCompactThreshold('96').valid).toBe(false);

    // Rechaza umbral con decimales en /settings (opción 8)
    step = 0;
    const invalidThresholdAnswers = ['8', '75.5'];
    updated = await runSettingsCommand(
      updated,
      async () => invalidThresholdAnswers[step++] ?? '',
      (m) => logs.push(m),
      tempHome,
    );
    expect(updated.autoCompactThreshold).toBe(70);

    // Acepta umbral entero válido en /settings (opción 8 -> 80) y lo guarda al instante
    step = 0;
    const validThresholdAnswers = ['8', '80'];
    updated = await runSettingsCommand(
      updated,
      async () => validThresholdAnswers[step++] ?? '',
      (m) => logs.push(m),
      tempHome,
    );
    expect(updated.autoCompactThreshold).toBe(80);
    expect(loadSettings(tempHome).autoCompactThreshold).toBe(80);
  });

  it('avisa cuando un comando de configuración (/effort, /model, /settings) recibe el valor ya activo o un alias equivalente sin modificar el archivo en disco', async () => {
    const settingsFile = getSettingsPath(tempHome);
    const initial: GlitchSettings = {
      ...baseSettings,
      provider: 'vertex',
      vertex: { project: 'test-proj', location: 'us-central1' },
      model: 'gemini-4-argon',
      effort: 'medium',
      permissionMode: 'always_allow',
      subMode: 'agent',
      autoCompact: true,
      autoCompactThreshold: 70,
    };

    // Verifica la función única reutilizable notifyUnchanged
    expect(notifyUnchanged('effort', 'Medio')).toBe(
      'El esfuerzo ya está en Medio.',
    );
    expect(notifyUnchanged('model', 'Gemini 4 Argon')).toBe(
      'El modelo ya es Gemini 4 Argon.',
    );

    const logs: string[] = [];
    expect(fs.existsSync(settingsFile)).toBe(false);

    // 1. Mismo valor y alias en /effort ("medium", "med", "MEDIO"): no guarda en disco y muestra aviso
    const sameEffort = runEffortCommand(
      initial,
      'medium',
      (m) => logs.push(m),
      tempHome,
    );
    expect(sameEffort).toBe(initial);
    expect(logs.at(-1)).toBe('El esfuerzo ya está en Medio.');
    expect(fs.existsSync(settingsFile)).toBe(false);

    runEffortCommand(initial, '  MED ', (m) => logs.push(m), tempHome);
    expect(logs.at(-1)).toBe('El esfuerzo ya está en Medio.');
    expect(fs.existsSync(settingsFile)).toBe(false);

    // 2. Mismo valor en /model (incluso durante petición activa "Pensando..."): no guarda en disco y muestra aviso
    const sameModel = await runModelCommand(
      initial,
      LOCAL_GOOGLE_MODELS,
      true,
      'GEMINI-4-ARGON',
      async () => '',
      (m) => logs.push(m),
      tempHome,
    );
    expect(sameModel).toBe(initial);
    expect(logs.at(-1)).toBe('El modelo ya es Gemini 4 Argon.');
    expect(fs.existsSync(settingsFile)).toBe(false);

    // 3. Mismo valor en opciones de /settings: no guarda en disco y muestra aviso
    const sameAutoCompact = applySettingOptionValue(
      initial,
      'autocompactacion',
      'activada',
      (m) => logs.push(m),
      tempHome,
    );
    expect(sameAutoCompact.changed).toBe(false);
    expect(logs.at(-1)).toBe('La autocompactación ya está en Activada.');
    expect(fs.existsSync(settingsFile)).toBe(false);

    const sameThreshold = applySettingOptionValue(
      initial,
      'umbral',
      '70%',
      (m) => logs.push(m),
      tempHome,
    );
    expect(sameThreshold.changed).toBe(false);
    expect(logs.at(-1)).toBe('El umbral de autocompactación ya está en 70%.');
    expect(fs.existsSync(settingsFile)).toBe(false);

    const sameSubMode = applySettingOptionValue(
      initial,
      'submodo',
      'agente',
      (m) => logs.push(m),
      tempHome,
    );
    expect(sameSubMode.changed).toBe(false);
    expect(logs.at(-1)).toBe('El sub-modo ya está en Agente.');
    expect(fs.existsSync(settingsFile)).toBe(false);

    // 4. Valor inválido muestra error con lista de permitidos y no modifica el archivo
    runEffortCommand(initial, 'ultra', (m) => logs.push(m), tempHome);
    expect(logs.at(-1)).toContain('no válido');
    expect(logs.at(-1)).toContain('Bajo, Medio, Alto');
    expect(fs.existsSync(settingsFile)).toBe(false);

    // 5. Valor distinto cambia de verdad, confirma indicando anterior y nuevo, y guarda en disco
    const changedEffort = runEffortCommand(
      initial,
      'alto',
      (m) => logs.push(m),
      tempHome,
    );
    expect(changedEffort.effort).toBe('high');
    expect(logs.at(-1)).toContain('Esfuerzo cambiado de Medio a Alto');
    expect(fs.existsSync(settingsFile)).toBe(true);

    // 6. Paso 10: nuevas opciones de /settings (thinkingDisplay, thinkingSummaryModel, subagentMaxSteps, regionalSurchargePct, precio con pricingEditedModels)
    let curCfg = changedEffort;
    curCfg = applySettingOptionValue(
      curCfg,
      'thinkingDisplay',
      'auto',
      (m) => logs.push(m),
      tempHome,
    ).settings;
    expect(curCfg.thinkingDisplay).toBe('auto');

    curCfg = applySettingOptionValue(
      curCfg,
      'thinkingSummaryModel',
      'gemini-2.5-flash',
      (m) => logs.push(m),
      tempHome,
    ).settings;
    expect(curCfg.thinkingSummaryModel).toBe('gemini-2.5-flash');

    curCfg = applySettingOptionValue(
      curCfg,
      'subagentMaxSteps',
      '15',
      (m) => logs.push(m),
      tempHome,
    ).settings;
    expect(curCfg.subagentMaxSteps).toBe(15);

    curCfg = applySettingOptionValue(
      curCfg,
      'regionalSurchargePct',
      '10',
      (m) => logs.push(m),
      tempHome,
    ).settings;
    expect(curCfg.regionalSurchargePct).toBe(10);

    curCfg = applySettingOptionValue(
      curCfg,
      'precio',
      'gemini-2.5-flash 0.45 2.80 0.04',
      (m) => logs.push(m),
      tempHome,
    ).settings;
    expect(curCfg.modelPricing?.['gemini-2.5-flash']?.inputPerMillion).toBe(
      0.45,
    );
    expect(curCfg.pricingEditedModels).toContain('gemini-2.5-flash');
  });

  it('parsea flags --m y --message y abre nuevas ventanas de Glitch CLI con mensaje inicial', async () => {
    expect(parseMessageFlag(['--m', 'Hola,', 'nueva', 'terminal'])).toBe(
      'Hola, nueva terminal',
    );
    expect(parseMessageFlag(['--m', 'Hola, nueva terminal'])).toBe(
      'Hola, nueva terminal',
    );
    expect(
      parseMessageFlag([
        '--message',
        'Repara',
        'la',
        'terminal',
        'y',
        'ejecuta',
        'tests',
      ]),
    ).toBe('Repara la terminal y ejecuta tests');
    expect(
      parseMessageFlag([
        '--DAA',
        '-m',
        'gemini-2.5-flash',
        '--m',
        'Hola,',
        'nueva',
        'terminal',
      ]),
    ).toBe('Hola, nueva terminal');
    expect(
      parseModelFlag([
        '--DAA',
        '-m',
        'gemini-2.5-flash',
        '--m',
        'Hola,',
        'nueva',
        'terminal',
      ]),
    ).toBe('gemini-2.5-flash');
    expect(hasSameWindowFlag(['--same-window', '--m', 'Hola'])).toBe(true);

    const parsedShort = parseGlitchWindowShellCommand(
      'glitch --m Hola, nueva terminal',
    );
    expect(parsedShort).toEqual({ message: 'Hola, nueva terminal' });

    const parsedLong = parseGlitchWindowShellCommand(
      'glitch --DAA -m gemini-2.5-flash --message "Revisa que la terminal inicie bien"',
    );
    expect(parsedLong).toEqual({
      message: 'Revisa que la terminal inicie bien',
      daa: true,
      model: 'gemini-2.5-flash',
    });

    const winRes = spawnGlitchTerminalWindow({
      message: 'Hola, nueva terminal',
    });
    expect(winRes.result).toContain('Hola, nueva terminal');
    expect(winRes.launchedCommand).toContain('--same-window');

    const shellToolRes = await executeGlitchToolCallAsync(
      'run_shell_command',
      { command: 'glitch --m Hola, nueva terminal' },
      'always_allow',
      'agent',
    );
    expect(shellToolRes.error).toBeUndefined();
    expect(shellToolRes.result).toContain('Hola, nueva terminal');
  });
});
