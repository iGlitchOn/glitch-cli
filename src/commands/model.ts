import {
  formatModelRowColumns,
  getModelDefinition,
  groupModelsByFamilyPages,
  type ModelDefinition,
} from '../config/models.js';
import {
  saveSettings,
  type GlitchSettings,
} from '../config/settings.js';
import type { OutputFn, QuestionFn } from './auth.js';

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

  const trimmedArg = args.trim();
  let selectedId = '';

  if (trimmedArg) {
    const byIndex = Number.parseInt(trimmedArg, 10);
    if (
      !Number.isNaN(byIndex) &&
      byIndex >= 1 &&
      byIndex <= availableModels.length
    ) {
      selectedId = availableModels[byIndex - 1]!.id;
    } else {
      selectedId = trimmedArg;
    }
  } else {
    const pages = groupModelsByFamilyPages(availableModels);
    out('=== Modelos disponibles por familia (/model) ===');
    out(
      `  ${'NOMBRE DEL MODELO'.padEnd(38, ' ')} | ${'ID MODELO'.padEnd(34, ' ')} | EFFORTS APLICABLES`,
    );
    out('  ' + '-'.repeat(96));
    let globalIdx = 1;
    pages.forEach((page, pageIdx) => {
      out(`  [Página ${pageIdx + 1}/${pages.length}: ${page.title}]`);
      for (const m of page.models) {
        const isCurrent = m.id === currentSettings.model;
        const row = formatModelRowColumns(m, isCurrent);
        out(
          `  ${String(globalIdx).padStart(2, ' ')}) ${row.formatted}`,
        );
        globalIdx++;
      }
    });

    const answer = (
      await ask('Selecciona número o ID del modelo (Enter para cancelar): ')
    ).trim();
    if (!answer) {
      out('Cambio de modelo cancelado.');
      return currentSettings;
    }

    const indexChoice = Number.parseInt(answer, 10);
    if (
      !Number.isNaN(indexChoice) &&
      indexChoice >= 1 &&
      indexChoice <= availableModels.length
    ) {
      selectedId = availableModels[indexChoice - 1]!.id;
    } else {
      selectedId = answer;
    }
  }

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
  if (
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
      ? ` (effort activo: ${updated.effort.toUpperCase()})`
      : ' (effort: N/A)';
  out(`✓ Modelo cambiado a ${def.name} (${updated.model})${effortNotice}.`);
  return updated;
}
