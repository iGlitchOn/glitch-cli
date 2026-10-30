/**
 * Extrae recursivamente el código HTTP y el mensaje limpio cuando el SDK de Vertex AI
 * o un proveedor devuelve JSON anidado dentro de `error.message`.
 * Devuelve: `Code: 429 Message: Resource exhausted...` sin bloques JSON crudos.
 */
export function formatCleanApiError(err: unknown): string {
  let foundCode: number | string | undefined;
  let currentMessage =
    err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);

  if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    if (typeof rec['status'] === 'number' || typeof rec['code'] === 'number') {
      foundCode = (rec['status'] ?? rec['code']) as number;
    }
  }

  // Quita prefijos como "Error: " antes de intentar parsear JSON
  currentMessage = currentMessage.replace(/^[x]\s*Error:\s*/i, '').trim();

  for (let depth = 0; depth < 5; depth++) {
    const jsonCandidate = extractJsonSubstring(currentMessage);
    if (!jsonCandidate) break;

    try {
      const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
      const errObj =
        parsed['error'] && typeof parsed['error'] === 'object'
          ? (parsed['error'] as Record<string, unknown>)
          : parsed;

      if (
        foundCode === undefined &&
        (typeof errObj['code'] === 'number' || typeof errObj['code'] === 'string')
      ) {
        foundCode = errObj['code'] as number | string;
      }

      if (typeof errObj['message'] === 'string' && errObj['message'].trim()) {
        currentMessage = errObj['message'].trim();
        continue;
      }
      break;
    } catch {
      break;
    }
  }

  const singleLineMessage = currentMessage.replace(/\s+/g, ' ').trim();
  if (foundCode !== undefined) {
    return `Code: ${foundCode} Message: ${singleLineMessage}`;
  }
  return `Message: ${singleLineMessage}`;
}

function extractJsonSubstring(text: string): string | null {
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  return text.slice(firstBrace, lastBrace + 1);
}

/**
 * Formatea una duración en milisegundos al estilo compacto: "4s", "1m 12s", "1h 30m".
 */
export function formatElapsedDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Formatea una fecha al estilo "10/25/2026 8:41 PM".
 */
export function formatMessageTimestamp(date: Date = new Date()): string {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = date.getFullYear();

  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;

  return `${month}/${day}/${year} ${hours}:${minutes} ${ampm}`;
}
