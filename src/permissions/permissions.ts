import type { PermissionMode, SubMode } from '../config/settings.js';

export type ActionRisk = 'safe' | 'insecure';

export interface ActionDescriptor {
  name: string;
  description?: string;
  risk?: ActionRisk;
  modifiesState?: boolean;
}

export type PermissionDecision = 'allow' | 'ask' | 'deny';

export interface PermissionResult {
  decision: PermissionDecision;
  risk: ActionRisk;
  reason: string;
}

const SAFE_ACTION_PATTERNS = [
  /^read/i,
  /^list/i,
  /^get/i,
  /^search/i,
  /^grep/i,
  /^glob/i,
  /^inspect/i,
  /^status/i,
];

const INSECURE_ACTION_PATTERNS = [
  /^write/i,
  /^delete/i,
  /^remove/i,
  /^rm/i,
  /^exec/i,
  /^shell/i,
  /^bash/i,
  /^cmd/i,
  /^powershell/i,
  /^edit/i,
  /^replace/i,
  /^network/i,
  /^publish/i,
];

export function classifyActionRisk(
  action: string | ActionDescriptor,
): ActionRisk {
  if (typeof action !== 'string' && action.risk) {
    return action.risk;
  }

  const name = typeof action === 'string' ? action.trim() : action.name.trim();
  if (INSECURE_ACTION_PATTERNS.some((rx) => rx.test(name))) {
    return 'insecure';
  }
  if (SAFE_ACTION_PATTERNS.some((rx) => rx.test(name))) {
    return 'safe';
  }

  return 'insecure';
}

export function doesActionModifyState(
  action: string | ActionDescriptor,
): boolean {
  if (typeof action !== 'string' && typeof action.modifiesState === 'boolean') {
    return action.modifiesState;
  }
  return classifyActionRisk(action) === 'insecure';
}

/**
 * Evalúa si una acción está permitida, requiere confirmación o se rechaza
 * según el modo de permisos (Always Allow, Ask only insecure, Always Ask)
 * y el sub-modo (Plan vs Agent).
 */
export function checkPermission(
  action: string | ActionDescriptor,
  permissionMode: PermissionMode,
  subMode: SubMode = 'agent',
): PermissionResult {
  const risk = classifyActionRisk(action);
  const modifies = doesActionModifyState(action);

  if (subMode === 'plan' && modifies) {
    return {
      decision: 'deny',
      risk,
      reason:
        'Sub-modo Plan activo: solo se permite planear y consultar; no se permite modificar nada.',
    };
  }

  switch (permissionMode) {
    case 'always_allow':
      return {
        decision: 'allow',
        risk,
        reason: 'Modo Always Allow activo.',
      };
    case 'ask_insecure':
      if (risk === 'safe') {
        return {
          decision: 'allow',
          risk,
          reason: 'Acción clasificada como safe en modo Ask only insecure.',
        };
      }
      return {
        decision: 'ask',
        risk,
        reason: 'Acción clasificada como insecure: requiere confirmación.',
      };
    case 'always_ask':
      return {
        decision: 'ask',
        risk,
        reason: 'Modo Always Ask activo: toda acción requiere confirmación.',
      };
  }
}

export function toggleSubMode(current: SubMode): SubMode {
  return current === 'plan' ? 'agent' : 'plan';
}
