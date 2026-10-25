import { getModelDefinition } from '../config/models.js';
import {
  saveSettings,
  type EffortLevel,
  type GlitchSettings,
} from '../config/settings.js';
import type { OutputFn } from './auth.js';

export function runEffortCommand(
  currentSettings: GlitchSettings,
  args: string,
  out: OutputFn = console.log,
  customHomeDir?: string,
): GlitchSettings {
  const provider = currentSettings.provider ?? 'vertex';
  const def = getModelDefinition(currentSettings.model, provider);
  const allowed = def.supportedEfforts;

  if (allowed.length === 0) {
    out(
      `ℹ El comando /effort no aplica para el modelo actual (${currentSettings.model}): no soporta thinkingLevel.`,
    );
    return currentSettings;
  }

  const rawArg = args.trim().toLowerCase();
  if (!rawArg) {
    const effective = allowed.includes(currentSettings.effort)
      ? currentSettings.effort
      : (def.defaultEffort ?? allowed[0]!);
    out(
      `Nivel de effort actual: ${effective.toUpperCase()} (modelo: ${currentSettings.model} | permitidos: ${allowed.map((e) => e.toUpperCase()).join(', ')})`,
    );
    return currentSettings;
  }

  if (rawArg === 'minimal' || rawArg.includes('budget')) {
    out(
      `✗ Nivel "${args.trim()}" rechazado: MINIMAL y thinking_budget no están permitidos (causan HTTP 400 en Argon/Vertex). Niveles permitidos para ${currentSettings.model}: ${allowed.join(', ')}.`,
    );
    return currentSettings;
  }

  if (!allowed.includes(rawArg as EffortLevel)) {
    out(
      `✗ Nivel "${args.trim()}" no válido para el modelo ${currentSettings.model}. Niveles permitidos: ${allowed.join(', ')}.`,
    );
    return currentSettings;
  }

  const nextEffort = rawArg as EffortLevel;
  const updated: GlitchSettings = {
    ...currentSettings,
    effort: nextEffort,
  };

  saveSettings(updated, customHomeDir);
  out(
    `✓ Nivel de effort actualizado a ${nextEffort.toUpperCase()} para ${currentSettings.model}.`,
  );
  return updated;
}
