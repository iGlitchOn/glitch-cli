import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  formatPermissionModeLabel,
  hasAlwaysAllowFlag,
  loadSettings,
  parseModelFlag,
  saveSettings,
  type GlitchSettings,
} from '../config/settings.js';
import {
  checkPermission,
  classifyActionRisk,
  toggleSubMode,
} from '../permissions/permissions.js';
import {
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
    const daaHelpEs = getSettingHelpDetail(4, 'es');
    expect(daaHelpEs.availableModesLabel).toBe('Modos disponibles:');
    expect(daaHelpEs.availableModes).toContain('Activa');
    expect(daaHelpEs.whatItDoesLabel).toBe('¿Qué hace?');
    expect(daaHelpEs.whatItDoes).toContain('--dangerously-always-allow');
  });
});
