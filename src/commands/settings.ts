import {
  formatPermissionModeLabel,
  saveSettings,
  type EffortLevel,
  type GlitchSettings,
  type PermissionMode,
  type SubMode,
} from '../config/settings.js';
import type { OutputFn, QuestionFn } from './auth.js';

const PERMISSION_OPTIONS: Array<{ id: PermissionMode; label: string }> = [
  { id: 'always_allow', label: 'Always Allow' },
  { id: 'ask_insecure', label: 'Ask only insecure' },
  { id: 'always_ask', label: 'Always Ask' },
];

const SUBMODE_OPTIONS: Array<{ id: SubMode; label: string }> = [
  { id: 'plan', label: 'Plan (solo planear, no modifica nada)' },
  { id: 'agent', label: 'Agent (puede modificar directamente)' },
];

const EFFORT_OPTIONS: EffortLevel[] = ['low', 'medium', 'high'];

export async function runSettingsCommand(
  currentSettings: GlitchSettings,
  ask: QuestionFn,
  out: OutputFn = console.log,
  customHomeDir?: string,
): Promise<GlitchSettings> {
  const modeLabel = formatPermissionModeLabel(currentSettings.permissionMode);
  const subModeLabel = currentSettings.subMode === 'plan' ? 'Plan' : 'Agent';
  const thoughtsLabel = currentSettings.thoughts ? 'ON' : 'OFF';
  const daaWarningLabel = currentSettings.hideDaaWarning ? 'OFF' : 'ON';

  out('=== Panel de Configuración y Comandos (/settings) ===');
  out('Comandos disponibles:');
  out('  /auth                     Configurar conexión (Vertex AI o API personalizada)');
  out('  /settings                 Abrir este panel de preferencias');
  out('  /model [id|num]           Seleccionar modelo disponible');
  out('  /effort [low|medium|high] Ver o cambiar el nivel de effort en vivo');
  out('  /help                     Mostrar ayuda y flags de línea de comandos');
  out('  /exit                     Salir de Glitch CLI');
  out('  Atajo de teclado          Shift+Tab (alterna Sub-Modo Plan <-> Agent en vivo)');
  out('-----------------------------------------------------');
  out('Preferencias actuales:');
  out(`  1) Modo de permisos           : ${modeLabel}`);
  out(`  2) Sub-Modo                   : ${subModeLabel}`);
  out(`  3) Esfuerzo por defecto       : ${currentSettings.effort.toUpperCase()}`);
  out(`  4) Thoughts                   : ${thoughtsLabel}`);
  out(`  5) Advertencia --DAA al inicio: ${daaWarningLabel}`);
  out('  Enter) Salir sin cambios');

  const choice = (await ask('Selecciona preferencia a cambiar [1-5]: ')).trim();
  if (!choice) {
    return currentSettings;
  }

  const updated: GlitchSettings = { ...currentSettings };

  if (choice === '1') {
    out('Selecciona el Modo de permisos:');
    PERMISSION_OPTIONS.forEach((opt, idx) => {
      const active =
        opt.id === currentSettings.permissionMode ? ' (actual)' : '';
      out(`  ${idx + 1}) ${opt.label}${active}`);
    });
    const ans = (await ask('Modo [1-3]: ')).trim();
    const idx = Number.parseInt(ans, 10) - 1;
    if (idx >= 0 && idx < PERMISSION_OPTIONS.length) {
      updated.permissionMode = PERMISSION_OPTIONS[idx]!.id;
      saveSettings(updated, customHomeDir);
      out(
        `✓ Modo de permisos actualizado a: ${PERMISSION_OPTIONS[idx]!.label}.`,
      );
    } else {
      out('✗ Selección de modo inválida.');
    }
    return updated;
  }

  if (choice === '2') {
    out('Selecciona el Sub-Modo:');
    SUBMODE_OPTIONS.forEach((opt, idx) => {
      const active = opt.id === currentSettings.subMode ? ' (actual)' : '';
      out(`  ${idx + 1}) ${opt.label}${active}`);
    });
    const ans = (await ask('Sub-Modo [1-2]: ')).trim();
    const idx = Number.parseInt(ans, 10) - 1;
    if (idx >= 0 && idx < SUBMODE_OPTIONS.length) {
      updated.subMode = SUBMODE_OPTIONS[idx]!.id;
      saveSettings(updated, customHomeDir);
      out(
        `✓ Sub-Modo actualizado a: ${updated.subMode === 'plan' ? 'Plan' : 'Agent'}.`,
      );
    } else {
      out('✗ Selección de sub-modo inválida.');
    }
    return updated;
  }

  if (choice === '3') {
    out('Selecciona Esfuerzo por defecto (low / medium / high):');
    EFFORT_OPTIONS.forEach((ef, idx) => {
      const active = ef === currentSettings.effort ? ' (actual)' : '';
      out(`  ${idx + 1}) ${ef.toUpperCase()}${active}`);
    });
    const ans = (await ask('Esfuerzo [1-3 o low/medium/high]: '))
      .trim()
      .toLowerCase();
    const byIdx = Number.parseInt(ans, 10) - 1;
    const picked =
      byIdx >= 0 && byIdx < EFFORT_OPTIONS.length
        ? EFFORT_OPTIONS[byIdx]
        : EFFORT_OPTIONS.find((e) => e === ans);
    if (picked) {
      updated.effort = picked;
      saveSettings(updated, customHomeDir);
      out(`✓ Esfuerzo por defecto actualizado a: ${picked.toUpperCase()}.`);
    } else {
      out('✗ Nivel de esfuerzo inválido.');
    }
    return updated;
  }

  if (choice === '4') {
    const ans = (await ask(`Thoughts [on/off, actual: ${thoughtsLabel}]: `))
      .trim()
      .toLowerCase();
    if (ans === 'on' || ans === 'true' || ans === '1') {
      updated.thoughts = true;
    } else if (ans === 'off' || ans === 'false' || ans === '0') {
      updated.thoughts = false;
    } else {
      updated.thoughts = !currentSettings.thoughts;
    }
    saveSettings(updated, customHomeDir);
    out(`✓ Thoughts actualizado a: ${updated.thoughts ? 'ON' : 'OFF'}.`);
    return updated;
  }

  if (choice === '5') {
    const ans = (
      await ask(
        `Advertencia --DAA al inicio [on/off, actual: ${daaWarningLabel}]: `,
      )
    )
      .trim()
      .toLowerCase();
    if (ans === 'off' || ans === 'false' || ans === '0') {
      updated.hideDaaWarning = true;
    } else if (ans === 'on' || ans === 'true' || ans === '1') {
      updated.hideDaaWarning = false;
    } else {
      updated.hideDaaWarning = !currentSettings.hideDaaWarning;
    }
    saveSettings(updated, customHomeDir);
    out(
      `✓ Advertencia --DAA al inicio actualizada a: ${updated.hideDaaWarning ? 'OFF' : 'ON'}.`,
    );
    return updated;
  }

  out('✗ Opción inválida en /settings.');
  return currentSettings;
}
