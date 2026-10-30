import { getModelDefinition } from '../config/models.js';
import {
  formatEffortValueEs,
  notifyUnchanged,
  resolveEffortAlias,
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
      `El comando /effort no aplica para el modelo actual (${currentSettings.model}): no soporta thinkingLevel.`,
    );
    return currentSettings;
  }

  const rawArg = args.trim().toLowerCase();
  if (!rawArg) {
    const effective = allowed.includes(currentSettings.effort)
      ? currentSettings.effort
      : (def.defaultEffort ?? allowed[0]!);
    out(
      `Nivel de esfuerzo actual: ${formatEffortValueEs(effective)} (${effective.toUpperCase()}) | Modelo: ${currentSettings.model} | Permitidos: ${allowed.map((e) => formatEffortValueEs(e)).join(', ')} (${allowed.map((e) => e.toUpperCase()).join(', ')})`,
    );
    return currentSettings;
  }

  if (
    rawArg === 'minimal' ||
    rawArg === 'mínimo' ||
    rawArg === 'minimo' ||
    rawArg.includes('budget')
  ) {
    out(
      `Nivel "${args.trim()}" rechazado: MINIMAL y thinking_budget no están permitidos (causan HTTP 400 en Argon/Vertex). Niveles permitidos para ${currentSettings.model}: ${allowed.join(', ')}.`,
    );
    return currentSettings;
  }

  let nextEffort: EffortLevel | null = null;
  if (/^\d+$/.test(rawArg)) {
    const byNum = Number.parseInt(rawArg, 10) - 1;
    if (byNum >= 0 && byNum < allowed.length) {
      nextEffort = allowed[byNum]!;
    }
  } else {
    nextEffort = resolveEffortAlias(rawArg);
  }

  if (!nextEffort || !allowed.includes(nextEffort)) {
    out(
      `Nivel "${args.trim()}" no válido para el modelo ${currentSettings.model}. Niveles permitidos: ${allowed.join(', ')} (${allowed.map((e) => formatEffortValueEs(e)).join(', ')}).`,
    );
    return currentSettings;
  }

  if (nextEffort === currentSettings.effort) {
    notifyUnchanged('effort', formatEffortValueEs(nextEffort), out);
    return currentSettings;
  }

  const prevEs = formatEffortValueEs(currentSettings.effort);
  const nextEs = formatEffortValueEs(nextEffort);
  const updated: GlitchSettings = {
    ...currentSettings,
    effort: nextEffort,
  };

  saveSettings(updated, customHomeDir);
  out(
    `Esfuerzo cambiado de ${prevEs} a ${nextEs} (${nextEffort.toUpperCase()}) para ${currentSettings.model}.`,
  );
  return updated;
}
