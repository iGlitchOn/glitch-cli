import {
  LOCAL_GOOGLE_MODELS,
  formatModelRowColumns,
  getModelDefinition,
  groupModelsByFamilyPages,
  type ModelDefinition,
} from '../config/models.js';
import {
  formatEffortValueEs,
  notifyUnchanged,
  resolveEffortAlias,
  saveSettings,
  type GlitchSettings,
} from '../config/settings.js';
import type { OutputFn, QuestionFn } from './auth.js';

export function parseModelAndEffortArgs(
  rawArgs: string,
  availableModels: readonly ModelDefinition[] = LOCAL_GOOGLE_MODELS,
): {
  modelArg: string;
  effortArg?: string;
} {
  const trimmed = rawArgs.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return { modelArg: '' };
  }

  const lowerFull = trimmed.toLowerCase();
  const exactFullMatch = availableModels.some(
    (m) =>
      m.id.toLowerCase() === lowerFull || m.name.toLowerCase() === lowerFull,
  );
  if (exactFullMatch) {
    return { modelArg: trimmed };
  }

  const parts = trimmed.split(' ').filter(Boolean);
  if (parts.length === 1) {
    return { modelArg: parts[0]! };
  }

  const lastToken = parts[parts.length - 1]!;
  const prefixModel = parts.slice(0, -1).join(' ');
  const lowerPrefix = prefixModel.toLowerCase();
  const prefixMatchesModel = availableModels.some(
    (m) =>
      m.id.toLowerCase() === lowerPrefix ||
      m.name.toLowerCase() === lowerPrefix,
  );

  if (resolveEffortAlias(lastToken) !== null || prefixMatchesModel || parts.length === 2) {
    return {
      modelArg: prefixModel,
      effortArg: lastToken.toLowerCase(),
    };
  }

  return { modelArg: trimmed };
}

export function applyModelAndOptionalEffort(
  currentSettings: GlitchSettings,
  availableModels: readonly ModelDefinition[],
  selectedQuery: string,
  effortArg: string | undefined,
  out: OutputFn = console.log,
  customHomeDir?: string,
  isRequestActive = false,
): { settings: GlitchSettings; changed: boolean } {
  const provider = currentSettings.provider ?? 'vertex';
  const cleanQuery = selectedQuery.trim();
  const lowerQuery = cleanQuery.toLowerCase().replace(/\s+/g, ' ');

  let matchedModel: ModelDefinition | undefined;
  if (/^\d+$/.test(cleanQuery)) {
    const byIndex = Number.parseInt(cleanQuery, 10);
    if (byIndex >= 1 && byIndex <= availableModels.length) {
      matchedModel = availableModels[byIndex - 1];
    }
  } else {
    matchedModel = availableModels.find(
      (m) =>
        m.id.toLowerCase() === lowerQuery ||
        m.name.toLowerCase() === lowerQuery ||
        m.id.toLowerCase() === lowerQuery.replace(/\s+/g, '-'),
    );
  }

  if (provider === 'vertex' && !matchedModel) {
    out(
      `Modelo "${cleanQuery}" no reconocido en la lista disponible de Vertex AI. Modelos permitidos: ${availableModels
        .slice(0, 5)
        .map((m) => `${m.name} (${m.id})`)
        .join(', ')}.`,
    );
    return { settings: currentSettings, changed: false };
  }

  const def = matchedModel ?? getModelDefinition(cleanQuery, provider);
  let nextEffort = currentSettings.effort;

  if (effortArg) {
    if (def.supportedEfforts.length === 0) {
      out(
        `El modelo ${def.name} (${def.id}) no soporta niveles de esfuerzo (ESFUERZO: N/A). Se seleccionó el modelo sin effort.`,
      );
    } else {
      const resolvedEffort = resolveEffortAlias(effortArg);
      if (!resolvedEffort || !def.supportedEfforts.includes(resolvedEffort)) {
        out(
          `El nivel de esfuerzo "${effortArg}" no es válido para ${def.name}. Niveles permitidos: ${def.supportedEfforts.map((e) => `${formatEffortValueEs(e)} (${e.toUpperCase()})`).join(' - ')}.`,
        );
        return { settings: currentSettings, changed: false };
      }
      nextEffort = resolvedEffort;
    }
  } else if (
    def.supportedEfforts.length > 0 &&
    !def.supportedEfforts.includes(nextEffort)
  ) {
    nextEffort = def.defaultEffort ?? def.supportedEfforts[0]!;
  }

  const isSameModel =
    def.id.toLowerCase() === currentSettings.model.toLowerCase();
  const isSameEffort = !effortArg || nextEffort === currentSettings.effort;

  if (isSameModel && isSameEffort) {
    notifyUnchanged('model', def.name, out);
    return { settings: currentSettings, changed: false };
  }

  if (isRequestActive) {
    out(
      'No se puede cambiar de modelo mientras hay una petición activa. Espera a que termine la tarea actual.',
    );
    return { settings: currentSettings, changed: false };
  }

  const prevDef = getModelDefinition(currentSettings.model, provider);
  const updated: GlitchSettings = {
    ...currentSettings,
    model: def.id,
    effort: nextEffort,
  };

  saveSettings(updated, customHomeDir);
  const effortNotice =
    def.supportedEfforts.length > 0
      ? ` (Esfuerzo: ${formatEffortValueEs(updated.effort)} / ${updated.effort.toUpperCase()})`
      : ' (Esfuerzo: N/A)';
  out(
    `Modelo cambiado de ${prevDef.name} a ${def.name} (${updated.model})${effortNotice}.`,
  );
  return { settings: updated, changed: true };
}

export async function runModelCommand(
  currentSettings: GlitchSettings,
  availableModels: readonly ModelDefinition[],
  isRequestActive: boolean,
  args: string,
  ask: QuestionFn,
  out: OutputFn = console.log,
  customHomeDir?: string,
): Promise<GlitchSettings> {
  const { modelArg, effortArg } = parseModelAndEffortArgs(
    args,
    availableModels,
  );

  if (modelArg) {
    const res = applyModelAndOptionalEffort(
      currentSettings,
      availableModels,
      modelArg,
      effortArg,
      out,
      customHomeDir,
      isRequestActive,
    );
    return res.settings;
  }

  if (isRequestActive) {
    out(
      'No se puede cambiar de modelo mientras hay una petición activa. Espera a que termine la tarea actual.',
    );
    return currentSettings;
  }

  const curDef = getModelDefinition(
    currentSettings.model,
    currentSettings.provider ?? 'vertex',
  );
  const pages = groupModelsByFamilyPages(availableModels);
  out(
    `=== Modelos disponibles por familia (/model) | Actual: ${curDef.name} (${currentSettings.model}) ===`,
  );
  out(
    `  ${'NOMBRE DEL MODELO'.padEnd(36, ' ')} | ${'ID MODELO'.padEnd(32, ' ')} | ${'FECHA'.padEnd(10, ' ')} | ESFUERZO`,
  );
  out('  ' + '-'.repeat(104));
  let globalIdx = 1;
  pages.forEach((page, pageIdx) => {
    out(`  [Página ${pageIdx + 1}/${pages.length}: ${page.title}]`);
    for (const m of page.models) {
      const isCurrent = m.id === currentSettings.model;
      const row = formatModelRowColumns(m, isCurrent, 36, 32, 10);
      out(`  ${String(globalIdx).padStart(2, ' ')}) ${row.formatted}`);
      globalIdx++;
    }
  });

  const answer = (
    await ask(
      'Selecciona número o ID (opcionalmente seguido de low|medium|high, Enter cancelar): ',
    )
  ).trim();
  if (!answer) {
    out('Cambio de modelo cancelado.');
    return currentSettings;
  }

  const parsedAnswer = parseModelAndEffortArgs(answer, availableModels);
  const res = applyModelAndOptionalEffort(
    currentSettings,
    availableModels,
    parsedAnswer.modelArg,
    parsedAnswer.effortArg,
    out,
    customHomeDir,
    isRequestActive,
  );
  return res.settings;
}
