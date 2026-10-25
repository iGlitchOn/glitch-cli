import { getModelDefinition } from '../config/models.js';
import type {
  GlitchSettings,
  PermissionMode,
  SubMode,
} from '../config/settings.js';

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  always_allow: 'Always Allow',
  ask_insecure: 'Ask only insecure',
  always_ask: 'Always Ask',
};

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

  const modeLabel = PERMISSION_LABELS[settings.permissionMode];
  const subModeLabel = SUBMODE_LABELS[settings.subMode];

  return `[Modelo: ${settings.model} | Effort: ${effortLabel} | Modo: ${modeLabel} | Sub-modo: ${subModeLabel}]`;
}
