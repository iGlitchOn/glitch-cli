export interface SlashCommandEntry {
  cmd: string;
  aliases: readonly string[];
  desc: string;
}

export const SLASH_COMMANDS: readonly SlashCommandEntry[] = [
  {
    cmd: '/new',
    aliases: ['clear', 'cls', 'clean', 'reset', 'limpiar', 'nuevo'],
    desc: 'Iniciar conversación limpia (alternativas: /clear, /cls, /reset)',
  },
  {
    cmd: '/resume',
    aliases: ['continue', 'history', 'sessions', 'load', 'retomar', 'historial'],
    desc: 'Retomar una conversación anterior guardada',
  },
  {
    cmd: '/model',
    aliases: ['models', 'm', 'modelo', 'modelos'],
    desc: 'Seleccionar modelo y esfuerzo (ej. /model gemini-4-argon high)',
  },
  {
    cmd: '/effort',
    aliases: ['thinking', 'esfuerzo', 'think', 'level'],
    desc: 'Ver o cambiar nivel de esfuerzo en vivo (low | medium | high)',
  },
  {
    cmd: '/settings',
    aliases: ['config', 'preferences', 'ajustes', 'opciones', 'cfg'],
    desc: 'Preferencias (Modo, Sub-Modo Plan/Agent, Esfuerzo, Thoughts, Aviso --DAA)',
  },
  {
    cmd: '/auth',
    aliases: ['login', 'connect', 'vertex', 'api', 'conexion'],
    desc: 'Configurar conexión (Vertex AI o API personalizada)',
  },
  {
    cmd: '/help',
    aliases: ['shortcuts', 'commands', 'ayuda', 'atajos', 'h'],
    desc: 'Mostrar comandos, flags (-m, --model, --DAA) y atajos',
  },
  {
    cmd: '/exit',
    aliases: ['quit', 'q', 'bye', 'salir', 'close'],
    desc: 'Salir de Glitch CLI',
  },
];

/**
 * Busca comandos por su nombre original o por cualquiera de sus alternativas/alias.
 * Si el usuario busca `/clear` o `/cl`, devuelve la entrada original `/new` para que
 * al seleccionarla se coloque y ejecute `/new`.
 */
export function matchSlashCommands(rawInput: string): SlashCommandEntry[] {
  const trimmed = rawInput.trim().toLowerCase();
  if (!trimmed.startsWith('/') || trimmed.includes(' ')) {
    return [];
  }
  const query = trimmed.slice(1);
  if (!query) {
    return [...SLASH_COMMANDS];
  }

  const directMatches: SlashCommandEntry[] = [];
  const aliasMatches: SlashCommandEntry[] = [];

  for (const item of SLASH_COMMANDS) {
    const cmdName = item.cmd.slice(1).toLowerCase();
    if (cmdName.startsWith(query)) {
      directMatches.push(item);
    } else if (item.aliases.some((alias) => alias.toLowerCase().startsWith(query))) {
      aliasMatches.push(item);
    }
  }

  return [...directMatches, ...aliasMatches];
}

/**
 * Resuelve cualquier comando o alias (ej. `/clear arg` -> `/new arg`, `/cls` -> `/new`)
 * a su comando canónico original.
 */
export function resolveSlashCommandAlias(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed.startsWith('/')) {
    return trimmed;
  }

  const spaceIdx = trimmed.indexOf(' ');
  const token = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);

  for (const item of SLASH_COMMANDS) {
    const cmdName = item.cmd.slice(1).toLowerCase();
    if (cmdName === token || item.aliases.some((a) => a.toLowerCase() === token)) {
      return `${item.cmd}${rest}`;
    }
  }

  return trimmed;
}
