import { getAppVersion } from '../config/settings.js';
import type { OutputFn } from './auth.js';

export interface SlashCommandEntry {
  cmd: string;
  displayCmd: string;
  aliases: readonly string[];
  desc: string;
}

export const SLASH_COMMANDS: readonly SlashCommandEntry[] = [
  {
    cmd: '/new',
    displayCmd: '/nuevo',
    aliases: ['new', 'nuevo', 'clear', 'cls', 'clean', 'reset', 'limpiar'],
    desc: 'Iniciar conversación limpia',
  },
  {
    cmd: '/resume',
    displayCmd: '/retomar',
    aliases: [
      'resume',
      'retomar',
      'continue',
      'history',
      'sessions',
      'load',
      'historial',
    ],
    desc: 'Retomar una conversación anterior guardada',
  },
  {
    cmd: '/model',
    displayCmd: '/modelo',
    aliases: ['model', 'models', 'm', 'modelo', 'modelos'],
    desc: 'Seleccionar modelo y esfuerzo (ej. /modelo gemini-4-argon high)',
  },
  {
    cmd: '/effort',
    displayCmd: '/esfuerzo',
    aliases: ['effort', 'esfuerzo', 'thinking', 'think', 'level'],
    desc: 'Ver o cambiar nivel de esfuerzo en vivo (low | medium | high)',
  },
  {
    cmd: '/usage',
    displayCmd: '/usage',
    aliases: ['usage', 'uso', 'context', 'contexto', 'tokens', 'stats', 'cost'],
    desc: 'Auditar de dónde sale el % de contexto, tokens reales, MCPs, skills y costos por petición',
  },
  {
    cmd: '/skills',
    displayCmd: '/skills',
    aliases: ['skills', 'skill', 'habilidades', 'habilidad'],
    desc: 'Inspeccionar las skills instaladas, ruta exacta en disco, ~tokens y subcomandos',
  },
  {
    cmd: '/mcp',
    displayCmd: '/mcp',
    aliases: ['mcp', 'mcps', 'servers', 'servidores'],
    desc: 'Inspeccionar servidores MCP detectados, archivo de origen, comando y herramientas',
  },
  {
    cmd: '/tui',
    displayCmd: '/tui',
    aliases: ['tui', 'renderer', 'interfaz'],
    desc: 'Cambiar renderizador (/tui <default|fullscreen>) y botones interactivos con ratón',
  },
  {
    cmd: '/settings',
    displayCmd: '/ajustes',
    aliases: [
      'settings',
      'ajustes',
      'config',
      'preferences',
      'opciones',
      'cfg',
    ],
    desc: 'Preferencias (Modo, Sub-Modo Plan/Agente, Esfuerzo)',
  },
  {
    cmd: '/auth',
    displayCmd: '/auth',
    aliases: ['auth', 'login', 'connect', 'vertex', 'api', 'conexion'],
    desc: 'Configurar conexión (Vertex AI o API personalizada)',
  },
  {
    cmd: '/version',
    displayCmd: '/version',
    aliases: ['version', 'ver', 'v'],
    desc: 'Mostrar la versión actual de Glitch CLI',
  },
  {
    cmd: '/help',
    displayCmd: '/ayuda',
    aliases: ['help', 'ayuda', 'shortcuts', 'commands', 'atajos', 'h'],
    desc: 'Mostrar comandos, flags (-m, --model, --m, --message, --DAA) y atajos',
  },
  {
    cmd: '/exit',
    displayCmd: '/salir',
    aliases: ['exit', 'salir', 'quit', 'q', 'bye', 'close'],
    desc: 'Salir de Glitch CLI',
  },
];

export const SKILL_SLASH_SUBCOMMANDS: readonly SlashCommandEntry[] = [
  {
    cmd: '/skill list',
    displayCmd: '/skill list',
    aliases: ['list', 'ls'],
    desc: 'Listar todas las skills, de dónde vienen y sus ~tokens aprox.',
  },
  {
    cmd: '/skill use',
    displayCmd: '/skill use',
    aliases: ['use', 'activate', 'on'],
    desc: 'Activar una skill por nombre en la sesión actual (/skill use <nombre>)',
  },
  {
    cmd: '/skill info',
    displayCmd: '/skill info',
    aliases: ['info', 'show'],
    desc: 'Ver de dónde viene una skill, ruta y ~tokens aprox. (/skill info <nombre>)',
  },
  {
    cmd: '/skill off',
    displayCmd: '/skill off',
    aliases: ['off', 'disable'],
    desc: 'Desactivar una skill activa (/skill off <nombre>)',
  },
  {
    cmd: '/skill clear',
    displayCmd: '/skill clear',
    aliases: ['clear', 'reset'],
    desc: 'Desactivar todas las skills activas de la sesión',
  },
];

export function matchSlashCommands(rawInput: string): SlashCommandEntry[] {
  const lowerRaw = rawInput.toLowerCase();
  if (lowerRaw.includes(' ')) {
    return [];
  }

  const trimmed = lowerRaw.trim();
  if (!trimmed.startsWith('/')) {
    return [];
  }
  const query = trimmed.slice(1);
  if (!query) {
    return [...SLASH_COMMANDS];
  }

  const directMatches: SlashCommandEntry[] = [];
  const aliasMatches: SlashCommandEntry[] = [];

  for (const item of SLASH_COMMANDS) {
    const cmdMain = item.cmd.slice(1).toLowerCase();
    const cmdEs = item.displayCmd.slice(1).toLowerCase();
    if (cmdMain.startsWith(query) || cmdEs.startsWith(query)) {
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

export function printHelpMenu(
  out: OutputFn = console.log,
  version: string = getAppVersion(),
): void {
  out(`Glitch CLI v${version} - Comandos dentro de Glitch CLI:`);
  out('  /new                      Iniciar conversación limpia');
  out('  /resume [num|id]          Retomar una conversación anterior guardada');
  out('  /model [id] [effort]      Seleccionar modelo y esfuerzo (ej. /model gemini-4-argon high)');
  out('  /effort [low|medium|high] Ver o cambiar el nivel de esfuerzo del modelo actual en vivo');
  out('  /usage                    Auditar de dónde salen el % de contexto, tokens, MCPs, skills y costos');
  out('  /skills | /skill [subcmd] Ver skills reales, de dónde vienen y ~tokens aprox. (list | use | info | off | clear)');
  out('  /mcp                      Ver servidores MCP detectados, archivo de origen, comando y herramientas');
  out('  /settings                 Panel de preferencias');
  out('  /auth                     Configurar conexión (Vertex AI o API personalizada)');
  out('  /version                  Mostrar la versión actual de Glitch CLI');
  out('  /help                     Mostrar esta ayuda');
  out('  /exit                     Salir de Glitch CLI');
  out('Flags al iniciar en terminal:');
  out('  glitch --DAA                        Iniciar forzando Always Allow sin sandbox (con aviso TUI de 3s)');
  out('  glitch --dangerously-always-allow   Equivalente a --DAA');
  out('  glitch --model gemini-2.5-flash     Iniciar directamente con un modelo específico');
  out('  glitch -m "gemini-2.5-flash"        Forma corta para elegir modelo al iniciar');
  out('  glitch --m Hola, nueva terminal     Abrir nueva ventana de Glitch CLI con ese mensaje inicial');
  out('  glitch --message "Mensaje largo"    Forma larga para abrir nueva ventana con un mensaje inicial');
  out('Atajos y Cola de Mensajes (Queue):');
  out('  ? (con barra vacía)       Mostrar panel de atajos al instante');
  out('  Shift+Tab / Alt+P         Alternar Sub-Modo (Plan <-> Agent) en vivo');
  out('  Flechas arriba/abajo      Subir/bajar por los mensajes en cola (Queue) y Enter para editarlos en su misma posición');
}
