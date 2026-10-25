import {
  getModelDefinition,
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
    out('=== Modelos disponibles (/model) ===');
    availableModels.forEach((m, idx) => {
      const currentMarker = m.id === currentSettings.model ? ' (actual)' : '';
      const effortsText =
        m.supportedEfforts.length > 0
          ? `effort: ${m.supportedEfforts.join('/')}`
          : 'effort: no aplica';
      out(`  ${idx + 1}) ${m.id} — ${m.name} [${effortsText}]${currentMarker}`);
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
      : ' (effort: no aplica)';
  out(`✓ Modelo cambiado a ${updated.model}${effortNotice}.`);
  return updated;
}
