import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Type, type FunctionDeclaration } from '@google/genai';
import type { PermissionMode, SubMode } from '../config/settings.js';
import { checkPermission } from '../permissions/permissions.js';
import { formatSkillTokens, type SkillInfo } from './skills.js';

/**
 * Resuelve cualquier ruta del sistema sin sandbox ni restricción al cwd:
 * - Expande `~` o `~/...` o `~\...` al directorio home del usuario (`os.homedir()`).
 * - Expande variables de entorno de Windows (`%USERPROFILE%`, `%APPDATA%`, etc.) y Unix (`$HOME`).
 * - Soporta rutas absolutas en cualquier unidad (`C:\...`, `D:\...`, `/...`) y rutas relativas al cwd.
 */
export function resolveAnySystemPath(
  rawPath: string | undefined,
  baseCwd: string = process.cwd(),
): string {
  const trimmed = (rawPath ?? '').trim().replace(/^["']|["']$/g, '');
  if (!trimmed) {
    return path.resolve(baseCwd);
  }

  let expanded = trimmed
    .replace(/%([^%]+)%/g, (_, envName: string) => {
      return process.env[envName] ?? `%${envName}%`;
    })
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, envName: string) => {
      return process.env[envName] ?? '';
    });

  if (expanded === '~') {
    expanded = os.homedir();
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  } else if (expanded === '$HOME') {
    expanded = os.homedir();
  } else if (expanded.startsWith('$HOME/') || expanded.startsWith('$HOME\\')) {
    expanded = path.join(os.homedir(), expanded.slice(6));
  }

  if (/^[A-Za-z]:$/.test(expanded)) {
    expanded = `${expanded}\\`;
  }

  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(baseCwd, expanded);
}

export const GLITCH_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'list_directory',
    description:
      'Lista archivos y carpetas de CUALQUIER directorio en todo el sistema del usuario (sin sandbox, acepta rutas absolutas como C:\Users\..., ~/Desktop, %APPDATA%, o relativas).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        dir_path: {
          type: Type.STRING,
          description:
            'Ruta absoluta, con ~, con %VAR%, o relativa del directorio a listar (por defecto el directorio actual).',
        },
      },
    },
  },
  {
    name: 'read_file',
    description:
      'Lee el contenido de CUALQUIER archivo en todo el sistema del usuario (sin restricción de carpeta inicial). Soporta rango opcional de líneas.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        file_path: {
          type: Type.STRING,
          description:
            'Ruta absoluta (ej. C:\Users\...), ~/..., o relativa del archivo a leer.',
        },
        start_line: {
          type: Type.INTEGER,
          description: 'Línea inicial opcional (basada en 1).',
        },
        end_line: {
          type: Type.INTEGER,
          description: 'Línea final opcional (basada en 1, inclusiva).',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Crea o sobrescribe CUALQUIER archivo en cualquier ruta del sistema del usuario (solo permitido en Sub-Modo Agente).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        file_path: {
          type: Type.STRING,
          description: 'Ruta absoluta o relativa del archivo a escribir.',
        },
        content: {
          type: Type.STRING,
          description: 'Contenido completo a escribir en el archivo.',
        },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Edita un archivo existente en cualquier parte del sistema reemplazando old_string por new_string (solo permitido en Sub-Modo Agente).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        file_path: {
          type: Type.STRING,
          description: 'Ruta absoluta o relativa del archivo a modificar.',
        },
        old_string: {
          type: Type.STRING,
          description: 'Texto exacto actual a buscar en el archivo.',
        },
        new_string: {
          type: Type.STRING,
          description: 'Nuevo texto que reemplazará a old_string.',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'delete_file',
    description:
      'Elimina un archivo o carpeta en cualquier parte del sistema del usuario (solo permitido en Sub-Modo Agente).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        file_path: {
          type: Type.STRING,
          description: 'Ruta absoluta o relativa del archivo o carpeta a eliminar.',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'grep_search',
    description:
      'Busca texto o expresión regular dentro de los archivos de cualquier carpeta del sistema.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pattern: {
          type: Type.STRING,
          description: 'Texto o expresión regular a buscar.',
        },
        dir_path: {
          type: Type.STRING,
          description:
            'Directorio raíz donde buscar (acepta cualquier ruta del sistema; por defecto el directorio actual).',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_shell_command',
    description:
      'Ejecuta cualquier comando de terminal PowerShell / CMD / sistema en el PC del usuario de forma asíncrona sin bloquear la consola (solo permitido en Sub-Modo Agente).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: 'Comando a ejecutar en el sistema.',
        },
        dir_path: {
          type: Type.STRING,
          description:
            'Directorio de trabajo opcional desde donde ejecutar el comando (cualquier ruta del PC).',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'activate_skill',
    description:
      'Carga y activa las instrucciones completas (SKILL.md) de una skill instalada por su nombre.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        skill_name: {
          type: Type.STRING,
          description: 'Nombre de la skill a activar.',
        },
      },
      required: ['skill_name'],
    },
  },
  {
    name: 'ask_user',
    description:
      'Hace una pregunta importante al usuario durante la ejecución mostrando un panel interactivo con opciones sugeridas y enviando una notificación del sistema.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        question: {
          type: Type.STRING,
          description: 'Pregunta clara y concisa para el usuario.',
        },
        header: {
          type: Type.STRING,
          description:
            'Etiqueta corta opcional para el encabezado (ej. "Arquitectura", "Decisión").',
        },
        options: {
          type: Type.ARRAY,
          items: {
            type: Type.STRING,
          },
          description:
            'Lista opcional de 2 a 4 opciones sugeridas para que el usuario elija rápidamente.',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'spawn_subagent',
    description:
      'Delega una tarea a un subagente autónomo con su propio contexto aislado y bucle de herramientas (list_directory, read_file, write_file, edit_file, delete_file, grep_search, run_shell_command, activate_skill). Si invocas múltiples llamadas a spawn_subagent en el mismo turno o usas spawn_parallel_subagents, todos los subagentes corren EN PARALELO al mismo tiempo sin bloquearse entre sí.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: {
          type: Type.STRING,
          description:
            'Nombre corto o rol del subagente (ej. "Agente 1 - Buscador Marketplace", "Agente 2 - Vigilante Messenger").',
        },
        task: {
          type: Type.STRING,
          description:
            'Instrucción completa, detallada y autónoma de la tarea que debe ejecutar el subagente y qué información debe retornar.',
        },
        sub_mode: {
          type: Type.STRING,
          description:
            'Modo del subagente: "agent" (lectura, escritura y comandos, por defecto) o "plan" (solo lectura y análisis).',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'spawn_parallel_subagents',
    description:
      'Levanta múltiples subagentes autónomos EN PARALELO al mismo tiempo (Promise.all) sin bloquearse entre sí (por ejemplo: Agente 1 buscando y enviando ofertas mientras Agente 2 vigila y negocia en Messenger en vivo). Devuelve de inmediato los IDs lanzados.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agents: {
          type: Type.ARRAY,
          description:
            'Lista de subagentes que se ejecutarán simultáneamente en paralelo.',
          items: {
            type: Type.OBJECT,
            properties: {
              name: {
                type: Type.STRING,
                description:
                  'Nombre o rol identificativo del subagente (ej. "Agente 1 - Marketplace", "Agente 2 - Messenger").',
              },
              task: {
                type: Type.STRING,
                description:
                  'Instrucción detallada y autónoma de la tarea para este subagente.',
              },
              sub_mode: {
                type: Type.STRING,
                description:
                  'Modo opcional del subagente: "agent" (por defecto) o "plan".',
              },
            },
            required: ['task'],
          },
        },
      },
      required: ['agents'],
    },
  },
  {
    name: 'esperar_subagentes',
    description:
      'Bloquea hasta que terminen (o se cancelen) los subagentes indicados por sus IDs y devuelve sus reportes finales en su functionResponse.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ids: {
          type: Type.ARRAY,
          items: {
            type: Type.STRING,
          },
          description:
            'Lista de IDs de subagentes a esperar (ej. ["subagent-1", "subagent-2"]). Si se omite o está vacía, espera a todos los subagentes en curso.',
        },
      },
    },
  },
  {
    name: 'cerrar_bloque',
    description:
      'Cierra el bloque de trabajo actual cuando hayas resuelto o completado un objetivo parcial (ej. "error 402"), generando un resumen corto del bloque.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        titulo: {
          type: Type.STRING,
          description:
            'Título corto del objetivo abordado en este bloque (ej. "error 402").',
        },
      },
      required: ['titulo'],
    },
  },
];

export function buildGlitchSystemInstruction(
  subMode: SubMode,
  activeSkillContents: readonly string[] = [],
  availableSkills: readonly SkillInfo[] = [],
  allowAgentQuestions = true,
): string {
  const base = [
    `Eres Glitch CLI, un agente de ingeniería de software y automatización en terminal con ACCESO TOTAL al sistema del usuario (${os.platform()} / ${os.arch()}), igual que Claude Code y Gemini CLI.`,
    `Sin importar desde qué carpeta se haya iniciado la sesión, tienes acceso completo a TODO el disco y sistema operativo (unidades C:\\, D:\\, ${os.homedir()}, %APPDATA%, procesos, red, etc.) a través de tus herramientas.`,
    `Directorio inicial actual: ${process.cwd()} | Usuario OS: ${os.userInfo().username} | Home: ${os.homedir()}`,
    `Sub-Modo actual: ${
      subMode === 'plan'
        ? 'Plan (modo solo lectura y diseño: puedes usar list_directory, read_file, grep_search, activate_skill, ask_user, spawn_subagent y spawn_parallel_subagents en modo lectura en cualquier ruta del PC, pero NO modifiques archivos ni ejecutes comandos de escritura)'
        : 'Agente (acceso total de lectura, escritura, ejecución y subagentes en paralelo en todo el sistema mediante list_directory, read_file, write_file, edit_file, delete_file, grep_search, run_shell_command, activate_skill, ask_user, spawn_subagent y spawn_parallel_subagents)'
    }.`,
    `Subagentes Nativos en Paralelo: cuentas con las herramientas nativas \`spawn_subagent\`, \`spawn_parallel_subagents\` y \`esperar_subagentes\`. Cuando el usuario te pida dividir el trabajo en agentes simultáneos, usa \`spawn_parallel_subagents\` (o múltiples llamadas a \`spawn_subagent\` en el mismo turno) para ejecutarlos en segundo plano sin bloquearse entre sí.`,
    `Apertura de nuevas ventanas de terminal: puedes abrir nuevas ventanas independientes de Glitch CLI ejecutando \`glitch --m Hola, nueva terminal\` (forma corta) o \`glitch --message "Instrucción completa..."\` (forma larga) con \`run_shell_command\`. Úsalo cuando el usuario te pida abrir otra ventana o cuando debas reparar/probar la terminal dejando una nueva instancia activa en caso de que el usuario no esté presente.`,
    `Subthinking obligatorio antes de cada comando: antes de invocar cualquier tool call (o grupo de calls paralelas), escribe SIEMPRE una frase corta, concreta y variada explicando qué acción técnica vas a realizar (ej. "Voy a modificar el núcleo del sistema", "Analizando el flujo de rutas en el despachador", "Actualizando la vista de historial de la TUI", "Compilando el proyecto y validando los tests"). Evita repetir muletillas como "Quiero..." al inicio de cada frase; varía tu redacción y ve directo al componente o acción concreta.`,
    `Cierre de bloque con cerrar_bloque: cuando consideres que resolviste o completaste un objetivo parcial dentro de la tarea (por ejemplo "error 402"), llama a la herramienta interna \`cerrar_bloque(titulo)\` para registrar el cierre de ese bloque y continuar con el siguiente.`,
    allowAgentQuestions
      ? `Cuando tengas una duda importante o decisión de diseño durante la generación, usa la función/herramienta ask_user para preguntarle al usuario con opciones claras.`
      : `Modo autónomo sin supervisión (allowAgentQuestions=OFF): tienes PROHIBIDO llamar a ask_user o detenerte a hacer preguntas; toma siempre la mejor decisión técnica por tu cuenta y continúa hasta terminar.`,
    `Cuando el usuario te pida inspeccionar archivos, editar código, revisar cualquier carpeta del PC o ejecutar comandos, usa directamente tus herramientas sin asumir restricciones de directorio.`,
    `Formato visual en la terminal: Glitch CLI renderiza Markdown real y color semántico en vivo. Usa **negritas** para títulos/secciones, \`backticks\` para colorear rutas/archivos/comandos automáticamente, *cursivas* para notas, y cuando quieras dar color explícito a palabras clave usa etiquetas como [cyan: texto], [green: texto], [yellow: texto], [magenta: texto] o [red: texto].`,
  ];

  if (availableSkills.length > 0) {
    const catalogLines = availableSkills
      .slice(0, 80)
      .map(
        (s) =>
          `- ${s.name} (${s.sourceLabel}, ${formatSkillTokens(s.approxTokens)}): ${s.description}`,
      )
      .join(os.EOL);
    base.push(
      `Catálogo de Skills reales instaladas (puedes activar cualquiera con la herramienta activate_skill):${os.EOL}${catalogLines}`,
    );
  }

  if (activeSkillContents.length > 0) {
    base.push(
      `Instrucciones de Skills activas en esta sesión:${os.EOL}${activeSkillContents.join(`${os.EOL}---${os.EOL}`)}`,
    );
  }

  return base.join(os.EOL);
}

function editFileContent(
  targetFile: string,
  oldStr: string,
  newStr: string,
): { result?: string; error?: string } {
  const current = fs.readFileSync(targetFile, 'utf-8');
  if (!oldStr) {
    return {
      error: `No se encontró el bloque old_string exacto dentro de ${targetFile}.`,
    };
  }
  if (current.includes(oldStr)) {
    const updated = current.replace(oldStr, () => newStr);
    fs.writeFileSync(targetFile, updated, 'utf-8');
    return { result: `Archivo editado correctamente: ${targetFile}` };
  }
  // Compatibilidad automática con saltos de línea CRLF (\r\n) o LF (\n)
  const crlfOld = oldStr.replace(/\r?\n/g, '\r\n');
  if (current.includes(crlfOld)) {
    const crlfNew = newStr.replace(/\r?\n/g, '\r\n');
    const updated = current.replace(crlfOld, () => crlfNew);
    fs.writeFileSync(targetFile, updated, 'utf-8');
    return { result: `Archivo editado correctamente: ${targetFile}` };
  }
  const lfOld = oldStr.replace(/\r?\n/g, '\n');
  if (current.includes(lfOld)) {
    const lfNew = newStr.replace(/\r?\n/g, '\n');
    const updated = current.replace(lfOld, () => lfNew);
    fs.writeFileSync(targetFile, updated, 'utf-8');
    return { result: `Archivo editado correctamente: ${targetFile}` };
  }
  return {
    error: `No se encontró el bloque old_string exacto dentro de ${targetFile}.`,
  };
}

const activeShellCancelCallbacks = new Set<() => void>();

export function killAllActiveShellCommands(): void {
  for (const cancel of Array.from(activeShellCancelCallbacks)) {
    try {
      cancel();
    } catch {
      // Ignorar
    }
  }
  activeShellCancelCallbacks.clear();
}

function killProcessTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.unref();
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Ignorar si el proceso ya terminó
  }
}

export interface GlitchWindowLaunchOptions {
  message: string;
  cwd?: string;
  model?: string;
  daa?: boolean;
}

export function parseGlitchWindowShellCommand(
  rawCmd: string,
): GlitchWindowLaunchOptions | null {
  const trimmed = rawCmd.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  const prefixMatch = trimmed.match(
    /^(?:start\s+(?:"[^"]*"\s+)?)?glitch(?:\.cmd|\.exe)?\s+([\s\S]+)$/i,
  );
  if (!prefixMatch?.[1]) return null;

  const argsPart = prefixMatch[1].trim();
  const msgFlagMatch = argsPart.match(
    /(?:^|\s)(?:--message|--m)(?:=|\s+)([\s\S]+)$/,
  );
  if (!msgFlagMatch || msgFlagMatch.index === undefined) return null;

  const beforeMsg = argsPart.slice(0, msgFlagMatch.index).trim();
  let rawMessage = (msgFlagMatch[1] ?? '').trim();

  if (/[;&|]/.test(beforeMsg)) return null;

  let daa =
    /(?:^|\s)(?:--DAA|--daa|-DAA|--DDA|--dda|-AA|--aa|--AA|--dangerously-always-allow)(?=\s|$)/.test(
      beforeMsg,
    );
  let model: string | undefined;
  const beforeModelMatch = beforeMsg.match(
    /(?:^|\s)(?:--model|-m)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/,
  );
  if (beforeModelMatch) {
    model =
      beforeModelMatch[1] ?? beforeModelMatch[2] ?? beforeModelMatch[3];
  }

  const trailingDaaMatch = rawMessage.match(
    /\s+(?:--DAA|--daa|-DAA|--DDA|--dda|-AA|--aa|--AA|--dangerously-always-allow)\s*$/,
  );
  if (trailingDaaMatch && trailingDaaMatch.index !== undefined) {
    daa = true;
    rawMessage = rawMessage.slice(0, trailingDaaMatch.index).trim();
  }

  if (
    (rawMessage.startsWith('"') && rawMessage.endsWith('"')) ||
    (rawMessage.startsWith("'") && rawMessage.endsWith("'"))
  ) {
    rawMessage = rawMessage.slice(1, -1).trim();
  }

  if (!rawMessage) return null;

  return {
    message: rawMessage,
    ...(daa ? { daa: true } : {}),
    ...(model ? { model } : {}),
  };
}

export function resolveGlitchCliEntryScript(): string {
  try {
    const distUrl = new URL('../../dist/index.js', import.meta.url);
    const distPath = path.normalize(
      process.platform === 'win32'
        ? decodeURIComponent(distUrl.pathname).replace(/^\/([A-Za-z]:)/, '$1')
        : decodeURIComponent(distUrl.pathname),
    );
    if (fs.existsSync(distPath)) {
      return distPath;
    }
  } catch {
    // Fallback
  }
  if (
    process.argv[1] &&
    (process.argv[1].endsWith('index.js') ||
      process.argv[1].endsWith('index.ts') ||
      process.argv[1].includes('glitch'))
  ) {
    return path.resolve(process.argv[1]);
  }
  return path.resolve(process.cwd(), 'dist', 'index.js');
}

export function spawnGlitchTerminalWindow(
  options: GlitchWindowLaunchOptions,
): { result?: string; error?: string; launchedCommand?: string } {
  const message = options.message.trim();
  if (!message) {
    return {
      error:
        'Debes indicar un mensaje inicial para abrir la nueva ventana (ej. glitch --m Hola, nueva terminal).',
    };
  }

  const targetCwd = resolveAnySystemPath(options.cwd);
  const entryScript = resolveGlitchCliEntryScript();
  const extraFlags: string[] = ['--same-window'];
  if (options.daa) extraFlags.push('--DAA');
  if (options.model) {
    extraFlags.push('--model', `"${options.model.replace(/"/g, '')}"`);
  }
  const safeMsgForArgv = message.replace(/["\r\n]/g, ' ').trim();
  extraFlags.push('--m', `"${safeMsgForArgv}"`);

  const innerCmd = `call "%GLITCH_CLI_NODE%" "%GLITCH_CLI_ENTRY%" ${extraFlags.join(' ')}`;
  const startCmd = `start "Glitch CLI" /d "%GLITCH_CLI_CWD%" cmd.exe /k ${innerCmd}`;

  if (process.env['VITEST']) {
    return {
      result: `Nueva ventana de Glitch CLI abierta con el mensaje: "${message}"`,
      launchedCommand: startCmd,
    };
  }

  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GLITCH_IN_SPAWNED_WINDOW: '1',
      GLITCH_INITIAL_MESSAGE: message,
      GLITCH_CLI_NODE: process.execPath,
      GLITCH_CLI_ENTRY: entryScript,
      GLITCH_CLI_CWD: targetCwd,
    };

    if (process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/d', '/c', startCmd], {
        cwd: targetCwd,
        env: childEnv,
        detached: true,
        windowsHide: false,
        windowsVerbatimArguments: true,
        stdio: 'ignore',
      });
      child.unref();
    } else if (process.platform === 'darwin') {
      const escaped = `${process.execPath} "${entryScript}" --same-window --m "${safeMsgForArgv}"`.replace(
        /"/g,
        '\\"',
      );
      const child = spawn(
        'osascript',
        [
          '-e',
          `tell application "Terminal" to do script "cd \\"${targetCwd}\\" && GLITCH_IN_SPAWNED_WINDOW=1 ${escaped}"`,
        ],
        {
          cwd: targetCwd,
          env: childEnv,
          detached: true,
          stdio: 'ignore',
        },
      );
      child.unref();
    } else {
      const child = spawn(
        'x-terminal-emulator',
        ['-e', process.execPath, entryScript, '--same-window', '--m', message],
        {
          cwd: targetCwd,
          env: childEnv,
          detached: true,
          stdio: 'ignore',
        },
      );
      child.unref();
    }

    return {
      result: `Nueva ventana de Glitch CLI abierta con el mensaje: "${message}"`,
      launchedCommand: startCmd,
    };
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? `No se pudo abrir la nueva ventana: ${err.message}`
          : `No se pudo abrir la nueva ventana: ${String(err)}`,
    };
  }
}

/**
 * Ejecuta un comando de consola de forma 100% asíncrona sin bloquear el event loop de Node.js ni congelar la TUI.
 * - Soporta cancelación inmediata mediante `abortSignal` (ESC).
 * - Si el proceso principal sale (`exit`) pero un subproceso nieto (ej. navegador lanzado en segundo plano)
 *   mantiene abiertos los descriptores stdout/stderr, libera los streams tras 350ms para nunca colgar la CLI 2 minutos.
 */
export function runShellCommandAsync(
  cmd: string,
  execCwd: string,
  abortSignal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<{ result?: string; error?: string }> {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve({ error: 'Comando cancelado por el usuario (ESC).' });
      return;
    }

    const windowLaunch = parseGlitchWindowShellCommand(cmd);
    if (windowLaunch) {
      resolve(
        spawnGlitchTerminalWindow({
          ...windowLaunch,
          cwd: execCwd,
        }),
      );
      return;
    }

    const shellOpt =
      process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let exitGraceTimer: ReturnType<typeof setTimeout> | null = null;

    const MAX_CAPTURE_CHARS = 32_000;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, {
        cwd: execCwd,
        shell: shellOpt,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (spawnErr) {
      resolve({
        error:
          spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
      });
      return;
    }

    const finish = (code: number | null, errMessage?: string) => {
      if (settled) return;
      settled = true;
      activeShellCancelCallbacks.delete(onAbort);
      clearTimeout(timeoutHandle);
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        // Ignorar
      }

      if (aborted) {
        resolve({ error: 'Comando cancelado por el usuario (ESC).' });
        return;
      }

      const combinedOut = stdoutBuf.trim();
      const combinedErr = stderrBuf.trim();

      if (timedOut) {
        const partial = [combinedOut, combinedErr]
          .filter(Boolean)
          .join(os.EOL)
          .slice(0, 16000);
        resolve({
          error: partial
            ? `Tiempo de espera agotado (${Math.round(timeoutMs / 1000)}s). Salida parcial:${os.EOL}${partial}`
            : `Tiempo de espera agotado (${Math.round(timeoutMs / 1000)}s) ejecutando el comando.`,
        });
        return;
      }

      if (code !== null && code !== 0) {
        const combined = [combinedOut, combinedErr, errMessage ?? '']
          .filter(Boolean)
          .join(os.EOL)
          .slice(0, 16000);
        resolve({
          error: combined || `El comando finalizó con código ${code}.`,
        });
        return;
      }

      if (errMessage && !combinedOut) {
        resolve({ error: errMessage.slice(0, 16000) });
        return;
      }

      const finalOutput =
        combinedOut && combinedErr
          ? `${combinedOut}${os.EOL}${combinedErr}`
          : combinedOut || combinedErr;
      resolve({
        result: finalOutput.slice(0, 16000) || '(comando ejecutado sin salida)',
      });
    };

    const onAbort = () => {
      aborted = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignorar
      }
      killProcessTree(child.pid);
      finish(1, 'Comando cancelado por el usuario (ESC).');
    };

    activeShellCancelCallbacks.add(onAbort);
    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
      finish(1, 'Timeout');
    }, timeoutMs);

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');

    child.stdout?.on('data', (chunk: string) => {
      if (stdoutBuf.length < MAX_CAPTURE_CHARS) {
        stdoutBuf += chunk.slice(0, MAX_CAPTURE_CHARS - stdoutBuf.length);
      }
    });

    child.stderr?.on('data', (chunk: string) => {
      if (stderrBuf.length < MAX_CAPTURE_CHARS) {
        stderrBuf += chunk.slice(0, MAX_CAPTURE_CHARS - stderrBuf.length);
      }
    });

    child.on('error', (err) => {
      finish(1, err.message);
    });

    // Si el proceso de shell ya salió pero un subproceso en segundo plano (ej. Chrome) heredó los pipes,
    // no esperamos 2 minutos a 'close'; damos 350ms para vaciar buffers y resolvemos de inmediato.
    child.on('exit', (code) => {
      if (settled) return;
      exitGraceTimer = setTimeout(() => {
        finish(code ?? 0);
      }, 350);
    });

    child.on('close', (code) => {
      finish(code ?? 0);
    });
  });
}

export async function executeGlitchToolCallAsync(
  name: string,
  args: Record<string, unknown>,
  permissionMode: PermissionMode,
  subMode: SubMode,
  availableSkills: readonly SkillInfo[] = [],
  onSkillActivated?: (skill: SkillInfo) => void,
  allowAgentQuestions = true,
  abortSignal?: AbortSignal,
): Promise<{ result?: string; error?: string }> {
  const perm = checkPermission(name, permissionMode, subMode);
  if (perm.decision === 'deny') {
    return { error: perm.reason };
  }

  if (name === 'run_shell_command') {
    const cmd = String(args['command'] ?? '').trim();
    const rawDir =
      typeof args['dir_path'] === 'string' ? args['dir_path'] : undefined;
    const execCwd = resolveAnySystemPath(rawDir);
    return runShellCommandAsync(cmd, execCwd, abortSignal, 120_000);
  }

  return executeGlitchToolCall(
    name,
    args,
    permissionMode,
    subMode,
    availableSkills,
    onSkillActivated,
    allowAgentQuestions,
  );
}

export function executeGlitchToolCall(
  name: string,
  args: Record<string, unknown>,
  permissionMode: PermissionMode,
  subMode: SubMode,
  availableSkills: readonly SkillInfo[] = [],
  onSkillActivated?: (skill: SkillInfo) => void,
  allowAgentQuestions = true,
): { result?: string; error?: string } {
  const perm = checkPermission(name, permissionMode, subMode);
  if (perm.decision === 'deny') {
    return { error: perm.reason };
  }

  try {
    if (name === 'cerrar_bloque') {
      return { result: 'bloque cerrado' };
    }
    if (name === 'ask_user') {
      if (!allowAgentQuestions) {
        return {
          result:
            'Modo autónomo sin supervisión (allowAgentQuestions=OFF): toma la decisión más robusta por tu cuenta y continúa sin esperar al usuario',
        };
      }
      const q = String(args['question'] ?? '').trim();
      return {
        result: q
          ? `Pregunta presentada al usuario: ${q}`
          : 'Pregunta presentada al usuario.',
      };
    }
    if (name === 'list_directory') {
      const rawDir =
        typeof args['dir_path'] === 'string' ? args['dir_path'] : undefined;
      const targetDir = resolveAnySystemPath(rawDir);
      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      const formatted = entries
        .slice(0, 250)
        .map((e) => (e.isDirectory() ? `[DIR]  ${e.name}` : `[FILE] ${e.name}`))
        .join(os.EOL);
      return {
        result: `Directorio: ${targetDir}${os.EOL}${formatted || '(vacío)'}`,
      };
    }

    if (name === 'read_file') {
      const rawFile = String(args['file_path'] ?? '');
      const targetFile = resolveAnySystemPath(rawFile);
      const content = fs.readFileSync(targetFile, 'utf-8');
      const startLine =
        typeof args['start_line'] === 'number' ? Math.max(1, args['start_line']) : undefined;
      const endLine =
        typeof args['end_line'] === 'number' ? Math.max(1, args['end_line']) : undefined;

      if (startLine !== undefined || endLine !== undefined) {
        const lf = String.fromCharCode(10);
        const lines = content.split(lf);
        const s = (startLine ?? 1) - 1;
        const e = endLine ?? lines.length;
        const slice = lines.slice(s, e).join(lf);
        return {
          result:
            slice.length > 24000
              ? `${slice.slice(0, 24000)}${os.EOL}...[truncado]...`
              : slice,
        };
      }

      return {
        result:
          content.length > 24000
            ? `${content.slice(0, 24000)}${os.EOL}...[truncado]...`
            : content,
      };
    }

    if (name === 'write_file') {
      const rawFile = String(args['file_path'] ?? '');
      const content = String(args['content'] ?? '');
      const targetFile = resolveAnySystemPath(rawFile);
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.writeFileSync(targetFile, content, 'utf-8');
      return { result: `Archivo escrito correctamente: ${targetFile}` };
    }

    if (name === 'edit_file') {
      const rawFile = String(args['file_path'] ?? '');
      const oldStr = String(args['old_string'] ?? '');
      const newStr = String(args['new_string'] ?? '');
      const targetFile = resolveAnySystemPath(rawFile);
      return editFileContent(targetFile, oldStr, newStr);
    }

    if (name === 'delete_file') {
      const rawFile = String(args['file_path'] ?? '');
      const targetPath = resolveAnySystemPath(rawFile);
      fs.rmSync(targetPath, { recursive: true, force: true });
      return { result: `Eliminado correctamente: ${targetPath}` };
    }

    if (name === 'grep_search') {
      const pattern = String(args['pattern'] ?? '').trim();
      const rawDir =
        typeof args['dir_path'] === 'string' ? args['dir_path'] : undefined;
      const targetDir = resolveAnySystemPath(rawDir);
      if (!pattern) {
        return { error: 'Se requiere un pattern para grep_search.' };
      }

      const matches: string[] = [];
      const rx = new RegExp(pattern, 'i');
      const walk = (dir: string, depth: number) => {
        if (depth > 5 || matches.length >= 100) return;
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (matches.length >= 100) break;
          if (
            entry.name === 'node_modules' ||
            entry.name === '.git' ||
            entry.name === 'dist'
          ) {
            continue;
          }
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full, depth + 1);
          } else if (entry.isFile()) {
            try {
              const stat = fs.statSync(full);
              if (stat.size > 512_000) continue;
              const txt = fs.readFileSync(full, 'utf-8');
              const lf = String.fromCharCode(10);
              const lines = txt.split(lf);
              for (let i = 0; i < lines.length; i++) {
                if (rx.test(lines[i]!)) {
                  matches.push(`${full}:${i + 1}: ${lines[i]!.trim()}`);
                  if (matches.length >= 100) break;
                }
              }
            } catch {
              // Ignora binarios o ilegibles
            }
          }
        }
      };

      walk(targetDir, 0);
      return {
        result:
          matches.length > 0
            ? matches.join(os.EOL)
            : `Sin coincidencias para "${pattern}" en ${targetDir}.`,
      };
    }

    if (name === 'run_shell_command') {
      const cmd = String(args['command'] ?? '').trim();
      const rawDir =
        typeof args['dir_path'] === 'string' ? args['dir_path'] : undefined;
      const execCwd = resolveAnySystemPath(rawDir);
      const windowLaunch = parseGlitchWindowShellCommand(cmd);
      if (windowLaunch) {
        return spawnGlitchTerminalWindow({
          ...windowLaunch,
          cwd: execCwd,
        });
      }
      const shellOpt =
        process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
      try {
        const output = execSync(cmd, {
          cwd: execCwd,
          shell: shellOpt,
          encoding: 'utf-8',
          timeout: 120000,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
        return {
          result: output.slice(0, 16000) || '(comando ejecutado sin salida)',
        };
      } catch (cmdErr) {
        const errObj = cmdErr as {
          stdout?: string | Buffer;
          stderr?: string | Buffer;
          message?: string;
        };
        const stdoutStr = errObj.stdout ? String(errObj.stdout) : '';
        const stderrStr = errObj.stderr ? String(errObj.stderr) : '';
        const combined = [stdoutStr, stderrStr, errObj.message ?? '']
          .filter(Boolean)
          .join(os.EOL)
          .slice(0, 16000);
        return { error: combined || 'Error al ejecutar el comando.' };
      }
    }

    if (name === 'activate_skill') {
      const skillName = String(args['skill_name'] ?? '').trim();
      const found = availableSkills.find(
        (s) => s.name.toLowerCase() === skillName.toLowerCase(),
      );
      if (!found) {
        return {
          error: `Skill "${skillName}" no encontrada. Disponibles: ${availableSkills.map((s) => s.name).join(', ')}`,
        };
      }
      onSkillActivated?.(found);
      return {
        result: `<activated_skill name="${found.name}" source="${found.sourceLabel}" tokens="${formatSkillTokens(found.approxTokens)}">${os.EOL}${found.content}${os.EOL}</activated_skill>`,
      };
    }

    return { error: `Herramienta desconocida: ${name}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function formatToolShortArgument(
  name: string,
  args: Record<string, unknown>,
  baseCwd: string = process.cwd(),
): string {
  const normalizedBase = path.resolve(baseCwd).toLowerCase();
  const rawDir =
    typeof args['dir_path'] === 'string' && args['dir_path'].trim()
      ? args['dir_path'].trim()
      : '';
  const isDifferentDir =
    Boolean(rawDir) &&
    resolveAnySystemPath(rawDir, baseCwd).toLowerCase() !== normalizedBase;

  if (typeof args['command'] === 'string' && args['command'].trim()) {
    const cmd = args['command'].replace(/\s+/g, ' ').trim();
    return isDifferentDir ? `${cmd} (${rawDir})` : cmd;
  }

  if (typeof args['file_path'] === 'string' && args['file_path'].trim()) {
    return args['file_path'].trim();
  }

  if (typeof args['pattern'] === 'string' && args['pattern'].trim()) {
    const pat = `"${args['pattern'].trim()}"`;
    return isDifferentDir || rawDir ? `${pat}  ${rawDir}` : pat;
  }

  if (rawDir) {
    return rawDir;
  }

  if (typeof args['skill_name'] === 'string' && args['skill_name'].trim()) {
    return args['skill_name'].trim();
  }

  if (typeof args['question'] === 'string' && args['question'].trim()) {
    return args['question'].replace(/\s+/g, ' ').trim();
  }

  if (name === 'spawn_subagent') {
    return typeof args['name'] === 'string' && args['name'].trim()
      ? args['name'].trim()
      : typeof args['task'] === 'string'
        ? args['task'].replace(/\s+/g, ' ').trim().slice(0, 60)
        : '';
  }

  if (name === 'spawn_parallel_subagents') {
    const agentsList = Array.isArray(args['agents']) ? args['agents'] : [];
    return agentsList
      .map((a, idx) => {
        if (
          a &&
          typeof a === 'object' &&
          typeof (a as Record<string, unknown>)['name'] === 'string'
        ) {
          return String((a as Record<string, unknown>)['name']).trim();
        }
        return `Agente ${idx + 1}`;
      })
      .join(', ');
  }

  if (name === 'esperar_subagentes') {
    const ids = Array.isArray(args['ids'])
      ? (args['ids'] as unknown[]).map(String).join(', ')
      : '';
    return ids || 'todos';
  }

  return '';
}

export function formatCompactToolDuration(durationMs?: number): string {
  if (durationMs === undefined || durationMs < 0) {
    return '';
  }
  if (durationMs < 10_000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  const totalSec = Math.floor(durationMs / 1000);
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

export function formatCompactToolCallLine(params: {
  name: string;
  args: Record<string, unknown>;
  durationMs?: number;
  status: 'en vivo' | 'listo' | 'error' | 'cancelado';
  baseCwd?: string;
}): string {
  const shortArg = formatToolShortArgument(
    params.name,
    params.args,
    params.baseCwd,
  ).slice(0, 64);
  const durStr = formatCompactToolDuration(params.durationMs);
  const parts = [params.name, shortArg, durStr, params.status].filter(
    (p) => p.length > 0,
  );
  return parts.join('  ');
}

export function formatToolActionSummary(
  name: string,
  args: Record<string, unknown>,
  baseCwd: string = process.cwd(),
): string {
  if (name === 'spawn_subagent') {
    const agentName =
      typeof args['name'] === 'string' && args['name'].trim()
        ? args['name'].trim()
        : 'Subagente';
    const taskPreview =
      typeof args['task'] === 'string'
        ? args['task'].replace(/\s+/g, ' ').trim().slice(0, 80)
        : '';
    return taskPreview
      ? `${name}  ${agentName} (${taskPreview})`
      : `${name}  ${agentName}`;
  }
  if (name === 'spawn_parallel_subagents') {
    const shortNames = formatToolShortArgument(name, args, baseCwd);
    return `${name}  ${shortNames || 'subagentes'}`;
  }
  const target = formatToolShortArgument(name, args, baseCwd);
  return target ? `${name}  ${target}` : name;
}
