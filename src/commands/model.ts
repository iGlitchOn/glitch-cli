import {
  formatModelRowColumns,
  getModelDefinition,
  groupModelsByFamilyPages,
  type ModelDefinition,
} from '../config/models.js';
import {
  saveSettings,
  type EffortLevel,
  type GlitchSettings,
} from '../config/settings.js';
import type { OutputFn, QuestionFn } from './auth.js';

const VALID_EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high'];

export function parseModelAndEffortArgs(rawArgs: string): {
  modelArg: string;
  effortArg?: string;
} {
  const parts = rawArgs
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) {
    return { modelArg: '' };
  }
  if (parts.length === 1) {
    return { modelArg: parts[0]! };
  }
  return {
    modelArg: parts[0]!,
    effortArg: parts[1]!.toLowerCase(),
  };
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
  if (isRequestActive) {
    out(
      '⚠ No se puede cambiar de modelo mientras hay una petición activa. Espera a que termine la tarea actual.',
    );
    return currentSettings;
  }

  const { modelArg, effortArg } = parseModelAndEffortArgs(args);
  let selectedId = '';

  if (modelArg) {
    const byIndex = Number.parseInt(modelArg, 10);
    if (
      !Number.isNaN(byIndex) &&
      byIndex >= 1 &&
      byIndex <= availableModels.length
    ) {
      selectedId = availableModels[byIndex - 1]!.id;
    } else {
      selectedId = modelArg;
    }
  } else {
    const pages = groupModelsByFamilyPages(availableModels);
    out('=== Modelos disponibles por familia (/model) ===');
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

    const parsedAnswer = parseModelAndEffortArgs(answer);
    const indexChoice = Number.parseInt(parsedAnswer.modelArg, 10);
    if (
      !Number.isNaN(indexChoice) &&
      indexChoice >= 1 &&
      indexChoice <= availableModels.length
    ) {
      selectedId = availableModels[indexChoice - 1]!.id;
    } else {
      selectedId = parsedAnswer.modelArg;
    }
    if (parsedAnswer.effortArg) {
      return applyModelAndOptionalEffort(
        currentSettings,
        availableModels,
        selectedId,
        parsedAnswer.effortArg,
        out,
        customHomeDir,
      );
    }
  }

  return applyModelAndOptionalEffort(
    currentSettings,
    availableModels,
    selectedId,
    effortArg,
    out,
    customHomeDir,
  );
}

function applyModelAndOptionalEffort(
  currentSettings: GlitchSettings,
  availableModels: readonly ModelDefinition[],
  selectedId: string,
  effortArg: string | undefined,
  out: OutputFn,
  customHomeDir?: string,
): GlitchSettings {
  const provider = currentSettings.provider ?? 'vertex';
  if (provider === 'vertex') {
    const existsInList = availableModels.some((m) => m.id === selectedId);
    if (!existsInList) {
      out(
        `✗ Modelo "${selectedId}" no reconocido en la lista disponible de Vertex AI.`,
      );
      return currentSettings;
    }
  }

  const def = getModelDefinition(selectedId, provider);
  let nextEffort = currentSettings.effort;

  if (effortArg) {
    if (def.supportedEfforts.length === 0) {
      out(
        `⚠ El modelo ${def.name} (${def.id}) no soporta niveles de esfuerzo (ESFUERZO: N/A). Se seleccionó el modelo sin effort.`,
      );
    } else if (
      !VALID_EFFORTS.includes(effortArg as EffortLevel) ||
      !def.supportedEfforts.includes(effortArg as EffortLevel)
    ) {
      out(
        `✗ El nivel de esfuerzo "${effortArg}" no es válido para ${def.name}. Niveles permitidos: ${def.supportedEfforts.map((e) => e.toUpperCase()).join(' - ')}.`,
      );
      return currentSettings;
    } else {
      nextEffort = effortArg as EffortLevel;
    }
  } else if (
    def.supportedEfforts.length > 0 &&
    !def.supportedEfforts.includes(nextEffort)
  ) {
    nextEffort = def.defaultEffort ?? def.supportedEfforts[0]!;
  }

  const updated: GlitchSettings = {
    ...currentSettings,
    model: def.id,
    effort: nextEffort,
  };

  saveSettings(updated, customHomeDir);
  const effortNotice =
    def.supportedEfforts.length > 0
      ? ` (Esfuerzo: ${updated.effort.toUpperCase()})`
      : ' (Esfuerzo: N/A)';
  out(`✓ Modelo cambiado a ${def.name} (${updated.model})${effortNotice}.`);
  return updated;
}
