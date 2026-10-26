import type { AppLanguage } from '../config/settings.js';

export interface SlashCommandEntry {
  /** Comando canónico interno */
  cmd: string;
  /** Comando mostrado según el idioma ('es' -> /esfuerzo, 'en' -> /effort) */
  displayCmd: Record<AppLanguage, string>;
  aliases: readonly string[];
  desc: Record<AppLanguage, string>;
}

export const SLASH_COMMANDS: readonly SlashCommandEntry[] = [
  {
    cmd: '/new',
    displayCmd: { es: '/nuevo', en: '/new' },
    aliases: ['new', 'nuevo', 'clear', 'cls', 'clean', 'reset', 'limpiar'],
    desc: {
      es: 'Iniciar conversación limpia',
      en: 'Start a clean conversation',
    },
  },
  {
    cmd: '/resume',
    displayCmd: { es: '/retomar', en: '/resume' },
    aliases: [
      'resume',
      'retomar',
      'continue',
      'history',
      'sessions',
      'load',
      'historial',
    ],
    desc: {
      es: 'Retomar una conversación anterior guardada',
      en: 'Resume a previously saved conversation',
    },
  },
  {
    cmd: '/model',
    displayCmd: { es: '/modelo', en: '/model' },
    aliases: ['model', 'models', 'm', 'modelo', 'modelos'],
    desc: {
      es: 'Seleccionar modelo y esfuerzo (ej. /modelo gemini-4-argon high)',
      en: 'Select model and effort (e.g. /model gemini-4-argon high)',
    },
  },
  {
    cmd: '/effort',
    displayCmd: { es: '/esfuerzo', en: '/effort' },
    aliases: ['effort', 'esfuerzo', 'thinking', 'think', 'level'],
    desc: {
      es: 'Ver o cambiar nivel de esfuerzo en vivo (low | medium | high)',
      en: 'View or change live effort level (low | medium | high)',
    },
  },
  {
    cmd: '/settings',
    displayCmd: { es: '/ajustes', en: '/settings' },
    aliases: [
      'settings',
      'ajustes',
      'config',
      'preferences',
      'opciones',
      'cfg',
    ],
    desc: {
      es: 'Preferencias (Modo, Sub-Modo Plan/Agente, Esfuerzo, Idioma)',
      en: 'Preferences (Mode, Sub-Mode Plan/Agent, Effort, Language)',
    },
  },
  {
    cmd: '/auth',
    displayCmd: { es: '/auth', en: '/auth' },
    aliases: ['auth', 'login', 'connect', 'vertex', 'api', 'conexion'],
    desc: {
      es: 'Configurar conexión (Vertex AI o API personalizada)',
      en: 'Configure connection (Vertex AI or Custom API)',
    },
  },
  {
    cmd: '/help',
    displayCmd: { es: '/ayuda', en: '/help' },
    aliases: ['help', 'ayuda', 'shortcuts', 'commands', 'atajos', 'h'],
    desc: {
      es: 'Mostrar comandos, flags (-m, --model, --DAA) y atajos',
      en: 'Show commands, CLI flags (-m, --model, --DAA), and shortcuts',
    },
  },
  {
    cmd: '/exit',
    displayCmd: { es: '/salir', en: '/exit' },
    aliases: ['exit', 'salir', 'quit', 'q', 'bye', 'close'],
    desc: {
      es: 'Salir de Glitch CLI',
      en: 'Exit Glitch CLI',
    },
  },
];

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
    const cmdEn = item.displayCmd.en.slice(1).toLowerCase();
    const cmdEs = item.displayCmd.es.slice(1).toLowerCase();
    if (cmdEn.startsWith(query) || cmdEs.startsWith(query)) {
      directMatches.push(item);
    } else if (
      item.aliases.some((alias) => alias.toLowerCase().startsWith(query))
    ) {
      aliasMatches.push(item);
    }
  }

  return [...directMatches, ...aliasMatches];
}

export function resolveSlashCommandAlias(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed.startsWith('/')) {
    return trimmed;
  }

  const spaceIdx = trimmed.indexOf(' ');
  const token = (
    spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)
  ).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);

  for (const item of SLASH_COMMANDS) {
    const cmdName = item.cmd.slice(1).toLowerCase();
    if (
      cmdName === token ||
      item.aliases.some((a) => a.toLowerCase() === token)
    ) {
      return `${item.cmd}${rest}`;
    }
  }

  return trimmed;
}
