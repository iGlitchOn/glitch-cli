import { runAuthFlow, type OutputFn, type QuestionFn } from '../commands/auth.js';
import { runEffortCommand } from '../commands/effort.js';
import { runModelCommand } from '../commands/model.js';
import { runSettingsCommand } from '../commands/settings.js';
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
}

export function printHelpMenu(out: OutputFn = console.log): void {
  out('Comandos dentro de Glitch CLI:');
  out('  /auth                     Configurar conexión (Vertex AI o API personalizada)');
  out('  /settings                 Panel de preferencias (Modo, Sub-Modo, Esfuerzo, Thoughts, Aviso --DAA)');
  out('  /model [id|num]           Seleccionar modelo por páginas (←/→ familia, ↑/↓ modelo)');
  out('  /effort [low|medium|high] Ver o cambiar el nivel de esfuerzo del modelo actual en vivo');
  out('  /help                     Mostrar esta ayuda');
  out('  /exit                     Salir de Glitch CLI');
  out('Flags al iniciar en terminal:');
  out('  glitch --DAA                        Iniciar en modo Always Allow sin sandbox (acceso total al PC)');
  out('  glitch --dangerously-always-allow   Equivalente a --DAA');
  out('  glitch --model gemini-2.5-flash     Iniciar directamente con un modelo específico');
  out('  glitch -m "gemini-2.5-flash"        Forma corta para elegir modelo al iniciar');
  out('Atajos y Cola de Mensajes (Queue):');
  out('  Shift+Tab / Alt+P         Alternar Sub-Modo (Plan <-> Agent) en vivo');
  out('  ↑ / ↓ durante respuesta   Subir/bajar por los mensajes en cola (Queue) y Enter para editarlos en su misma posición');
}

/**
 * Despacha una línea de entrada del usuario sin bloquearse por el AgentLoop:
 * - Si empieza con `/`, se procesa inmediatamente como slash command y NUNCA se envía al modelo.
 * - Si es texto normal, se encola en el AgentLoop sin bloquear el bucle de entrada.
 */
export async function handleUserInputLine(
  rawLine: string,
  opts: InputDispatcherOptions,
): Promise<{ handledAsSlash: boolean; queuedTask?: Promise<void> }> {
  const out = opts.out ?? console.log;
  const input = rawLine.trim();
  if (!input) {
    return { handledAsSlash: false };
  }

  if (input.startsWith('/')) {
    if (input === '/exit') {
      out('Cerrando Glitch CLI...');
      opts.onExit?.();
      return { handledAsSlash: true };
    }

    if (input === '/help') {
      printHelpMenu(out);
      return { handledAsSlash: true };
    }

    if (input === '/auth') {
      opts.session.settings = await runAuthFlow(
        opts.session.settings,
        opts.ask,
        out,
        opts.customHomeDir,
      );
      await opts.onAuthUpdated?.();
      return { handledAsSlash: true };
    }

    if (input === '/settings') {
      opts.session.settings = await runSettingsCommand(
        opts.session.settings,
        opts.ask,
        out,
        opts.customHomeDir,
      );
      return { handledAsSlash: true };
    }

    if (input === '/model' || input.startsWith('/model ')) {
      const args = input.slice('/model'.length).trim();
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

    if (input === '/effort' || input.startsWith('/effort ')) {
      const args = input.slice('/effort'.length).trim();
      opts.session.settings = runEffortCommand(
        opts.session.settings,
        args,
        out,
        opts.customHomeDir,
      );
      return { handledAsSlash: true };
    }

    out(
      `Comando desconocido: ${input}. Escribe /help para ver los comandos disponibles.`,
    );
    return { handledAsSlash: true };
  }

  const queuedTask = opts.agentLoop.enqueuePrompt(input);
  return { handledAsSlash: false, queuedTask };
}
