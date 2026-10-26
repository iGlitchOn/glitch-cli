import { runAuthFlow, type OutputFn, type QuestionFn } from '../commands/auth.js';
import { runEffortCommand } from '../commands/effort.js';
import { runModelCommand } from '../commands/model.js';
import { runSettingsCommand } from '../commands/settings.js';
import { resolveSlashCommandAlias } from '../commands/slashRegistry.js';
import { listSavedSessions } from './sessionStore.js';
import type { AgentLoop } from './agentLoop.js';
import type { SessionState } from './session.js';

export interface InputDispatcherOptions {
  session: SessionState;
  agentLoop: AgentLoop;
  ask: QuestionFn;
  out?: OutputFn;
  customHomeDir?: string;
  onExit?: () => void;
  onAuthUpdated?: () => Promise<void> | void;
  onNewSession?: () => void;
}

export function printHelpMenu(out: OutputFn = console.log): void {
  out('Comandos dentro de Glitch CLI:');
  out('  /new                      Iniciar conversación limpia');
  out('  /resume [num|id]          Retomar una conversación anterior guardada');
  out('  /model [id] [effort]      Seleccionar modelo y esfuerzo (ej. /model gemini-4-argon high)');
  out('  /effort [low|medium|high] Ver o cambiar el nivel de esfuerzo del modelo actual en vivo');
  out('  /settings                 Panel de preferencias (Modo, Sub-Modo, Esfuerzo, Thoughts, Aviso --DAA)');
  out('  /auth                     Configurar conexión (Vertex AI o API personalizada)');
  out('  /help                     Mostrar esta ayuda');
  out('  /exit                     Salir de Glitch CLI');
  out('Flags al iniciar en terminal:');
  out('  glitch --DAA                        Iniciar forzando Always Allow sin sandbox (con aviso TUI de 3s)');
  out('  glitch --dangerously-always-allow   Equivalente a --DAA');
  out('  glitch --model gemini-2.5-flash     Iniciar directamente con un modelo específico');
  out('  glitch -m "gemini-2.5-flash"        Forma corta para elegir modelo al iniciar');
  out('Atajos y Cola de Mensajes (Queue):');
  out('  ? (con barra vacía)       Mostrar panel de atajos al instante');
  out('  Shift+Tab / Alt+P         Alternar Sub-Modo (Plan <-> Agent) en vivo');
  out('  ↑ / ↓ durante respuesta   Subir/bajar por los mensajes en cola (Queue) y Enter para editarlos en su misma posición');
}

/**
 * Despacha una línea de entrada del usuario sin bloquearse por el AgentLoop:
 * - Si empieza con `/`, resuelve alternativas/alias (ej. /clear -> /new) y se procesa como slash command.
 * - Si es texto normal, se encola en el AgentLoop sin bloquear el bucle de entrada.
 */
export async function handleUserInputLine(
  rawLine: string,
  opts: InputDispatcherOptions,
): Promise<{ handledAsSlash: boolean; queuedTask?: Promise<void> }> {
  const out = opts.out ?? console.log;
  const trimmed = rawLine.trim();
  if (!trimmed) {
    return { handledAsSlash: false };
  }

  if (trimmed.startsWith('/')) {
    const resolved = resolveSlashCommandAlias(trimmed);

    if (resolved === '/exit') {
      out('Cerrando Glitch CLI...');
      opts.onExit?.();
      return { handledAsSlash: true };
    }

    if (resolved === '/help') {
      printHelpMenu(out);
      return { handledAsSlash: true };
    }

    if (resolved === '/new') {
      opts.session.history.length = 0;
      opts.onNewSession?.();
      out('✓ Nueva conversación iniciada (/new). Historial limpio.');
      return { handledAsSlash: true };
    }

    if (resolved === '/resume' || resolved.startsWith('/resume ')) {
      const arg = resolved.slice('/resume'.length).trim();
      const saved = listSavedSessions(opts.customHomeDir);
      if (saved.length === 0) {
        out('ℹ No hay conversaciones guardadas todavía para retomar con /resume.');
        return { handledAsSlash: true };
      }

      if (!arg) {
        out('=== Conversaciones guardadas (/resume) ===');
        saved.forEach((s, idx) => {
          out(
            `  ${idx + 1}) ${s.title} | Modelo: ${s.model} | Turnos: ${s.history.length} | ${s.updatedAt}`,
          );
        });
        return { handledAsSlash: true };
      }

      const byIdx = Number.parseInt(arg, 10);
      const target =
        !Number.isNaN(byIdx) && byIdx >= 1 && byIdx <= saved.length
          ? saved[byIdx - 1]
          : saved.find((s) => s.id === arg);
      if (!target) {
        out(`✗ No se encontró la sesión "${arg}".`);
        return { handledAsSlash: true };
      }

      opts.session.history.length = 0;
      opts.session.history.push(...target.history);
      out(`✓ Conversación retomada: "${target.title}" (${target.history.length} turnos).`);
      return { handledAsSlash: true };
    }

    if (resolved === '/auth') {
      opts.session.settings = await runAuthFlow(
        opts.session.settings,
        opts.ask,
        out,
        opts.customHomeDir,
      );
      await opts.onAuthUpdated?.();
      return { handledAsSlash: true };
    }

    if (resolved === '/settings') {
      opts.session.settings = await runSettingsCommand(
        opts.session.settings,
        opts.ask,
        out,
        opts.customHomeDir,
      );
      return { handledAsSlash: true };
    }

    if (resolved === '/model' || resolved.startsWith('/model ')) {
      const args = resolved.slice('/model'.length).trim();
      opts.session.settings = await runModelCommand(
        opts.session.settings,
        opts.session.availableModels,
        opts.session.isRequestActive,
        args,
        opts.ask,
        out,
        opts.customHomeDir,
      );
      return { handledAsSlash: true };
    }

    if (resolved === '/effort' || resolved.startsWith('/effort ')) {
      const args = resolved.slice('/effort'.length).trim();
      opts.session.settings = runEffortCommand(
        opts.session.settings,
        args,
        out,
        opts.customHomeDir,
      );
      return { handledAsSlash: true };
    }

    out(
      `Comando desconocido: ${trimmed}. Escribe /help para ver los comandos disponibles.`,
    );
    return { handledAsSlash: true };
  }

  const queuedTask = opts.agentLoop.enqueuePrompt(trimmed);
  return { handledAsSlash: false, queuedTask };
}
