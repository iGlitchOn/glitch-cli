import { getModelDefinition } from '../config/models.js';
import {
  formatPermissionModeLabel,
  type GlitchSettings,
  type SubMode,
} from '../config/settings.js';

const SUBMODE_LABELS: Record<SubMode, string> = {
  plan: 'Plan',
  agent: 'Agent',
};

export function formatStatusBar(settings: GlitchSettings): string {
  const provider = settings.provider ?? 'vertex';
  const def = getModelDefinition(settings.model, provider);
  const effortLabel =
    def.supportedEfforts.length > 0
      ? (def.supportedEfforts.includes(settings.effort)
          ? settings.effort
          : (def.defaultEffort ?? def.supportedEfforts[0]!)
        ).toUpperCase()
      : 'N/A';

  const modeLabel = formatPermissionModeLabel(settings.permissionMode);
  const subModeLabel = SUBMODE_LABELS[settings.subMode];

  return `Modelo: ${def.name} | Esfuerzo: ${effortLabel} | Modo: ${modeLabel} | Sub-Modo: ${subModeLabel}`;
}
