import type { Content, Part } from '@google/genai';

export const VERTEX_CONTINUE_PROMPT = 'continúa';

function isFunctionCallPart(part: Part): boolean {
  return Boolean(part && typeof part === 'object' && 'functionCall' in part && part.functionCall);
}

function isThoughtOnlyPart(part: Part): boolean {
  if (!part || typeof part !== 'object') return false;
  const record = part as Record<string, unknown>;
  return record['thought'] === true && !isFunctionCallPart(part);
}

function isModelTurnOnlyThoughts(content: Content): boolean {
  const parts = content.parts ?? [];
  if (parts.length === 0) return true;
  return parts.every((p) => isThoughtOnlyPart(p));
}

function hasFunctionCall(content: Content): boolean {
  const parts = content.parts ?? [];
  return parts.some((p) => isFunctionCallPart(p));
}

/**
 * Clona un Content preservando intactos todos los campos de cada Part
 * tal como los devuelve el SDK (incluyendo thoughtSignature, thought, functionCall, etc.).
 */
export function cloneContentPreservingSignatures(content: Content): Content {
  return {
    ...content,
    parts: content.parts ? content.parts.map((part) => ({ ...part })) : [],
  };
}

/**
 * Regla anti-400 de Vertex ("Requests ending with a model turn are not supported"):
 * - Conserva todos los parts e información de thoughtSignature tal cual.
 * - Si el último mensaje del historial es del modelo y solo contiene thoughts (o está vacío),
 *   descarta ese turno parcial.
 * - Si después de limpiar turnos parciales de thoughts el último mensaje sigue siendo del modelo
 *   y NO contiene un functionCall, agrega un turno de usuario "continúa".
 * - Es pura: no muta el arreglo recibido y puede invocarse antes de cada request y en cada reintento.
 */
export function normalizeHistoryForVertex(
  history: readonly Content[],
): Content[] {
  const cloned = history.map(cloneContentPreservingSignatures);

  while (cloned.length > 0) {
    const last = cloned[cloned.length - 1]!;
    if (last.role === 'model' && isModelTurnOnlyThoughts(last)) {
      cloned.pop();
    } else {
      break;
    }
  }

  if (cloned.length === 0) {
    return [{ role: 'user', parts: [{ text: VERTEX_CONTINUE_PROMPT }] }];
  }

  const last = cloned[cloned.length - 1]!;
  if (last.role === 'model' && !hasFunctionCall(last)) {
    cloned.push({
      role: 'user',
      parts: [{ text: VERTEX_CONTINUE_PROMPT }],
    });
  }

  return cloned;
}
