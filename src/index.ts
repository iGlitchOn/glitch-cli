#!/usr/bin/env node

import os from 'node:os';
import readline from 'node:readline';
import {
  formatAuthSummary,
  isAuthConfigured,
  loadSettings,
  saveSettings,
} from './config/settings.js';
import {
  LOCAL_GOOGLE_MODELS,
  listVertexGoogleModels,
} from './config/models.js';
import { runAuthFlow } from './commands/auth.js';
import { toggleSubMode } from './permissions/permissions.js';
import { formatStatusBar } from './ui/statusBar.js';
import {
  VertexProviderAdapter,
  createVertexGenAI,
} from './providers/vertex.js';
import { CustomProviderAdapter } from './providers/custom.js';
import type { ProviderAdapter } from './providers/types.js';
import { SessionState } from './core/session.js';
import { AgentLoop } from './core/agentLoop.js';
import { handleUserInputLine } from './core/inputLoop.js';

function createQuestionHelper(rl: readline.Interface) {
  return (promptText: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(promptText, (answer) => resolve(answer));
    });
}

function buildProviderAdapter(session: SessionState): ProviderAdapter {
  if (session.settings.provider === 'custom' && session.settings.custom) {
    return new CustomProviderAdapter(session.settings.custom);
  }
  if (session.settings.provider === 'vertex' && session.settings.vertex) {
    const ai = createVertexGenAI(session.settings.vertex);
    return new VertexProviderAdapter(ai);
  }
  throw new Error('Autenticación no configurada. Ejecuta /auth primero.');
}

async function refreshModelsIfNeeded(session: SessionState): Promise<void> {
  if (session.settings.provider === 'vertex' && session.settings.vertex) {
    try {
      const ai = createVertexGenAI(session.settings.vertex);
      session.availableModels = await listVertexGoogleModels(ai);
    } catch {
      session.availableModels = [...LOCAL_GOOGLE_MODELS];
    }
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log('Glitch CLI v0.1.0');
    return;
  }

  console.log('⚡ Glitch CLI v0.1.0');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'glitch> ',
  });
  const ask = createQuestionHelper(rl);

  const session = new SessionState(loadSettings());

  // Atajo de teclado en vivo: Shift+Tab (\x1b[Z) o Alt+P (\x1bp) alterna Sub-modo Plan <-> Agent
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl);
    process.stdin.on('keypress', (str: string, key?: readline.Key) => {
      const isShiftTab = key?.name === 'tab' && key?.shift === true;
      const isAltP = key?.name === 'p' && key?.meta === true;
      const isRawBacktab = str === '\x1b[Z';
      if (isShiftTab || isAltP || isRawBacktab) {
        const nextSubMode = toggleSubMode(session.settings.subMode);
        session.settings = { ...session.settings, subMode: nextSubMode };
        saveSettings(session.settings);
        process.stdout.write(
          `${os.EOL}⇄ Sub-modo cambiado a: ${nextSubMode === 'plan' ? 'Plan' : 'Agent'}${os.EOL}${formatStatusBar(session.settings)}${os.EOL}`,
        );
        rl.prompt(true);
      }
    });
  }

  if (!isAuthConfigured(session.settings)) {
    console.log('Primera ejecución detectada: configura tu conexión.');
    session.settings = await runAuthFlow(session.settings, ask);
  } else {
    console.log(`Conectado: ${formatAuthSummary(session.settings)}`);
  }

  await refreshModelsIfNeeded(session);

  const showPromptWithStatus = () => {
    console.log(formatStatusBar(session.settings));
    rl.prompt();
  };

  const agentLoop = new AgentLoop(
    session,
    () => buildProviderAdapter(session),
    (text) => process.stdout.write(text),
    (msg) => console.error(`${os.EOL}${msg}`),
  );

  showPromptWithStatus();

  await new Promise<void>((resolve) => {
    rl.on('line', (line) => {
      void (async () => {
        const trimmed = line.trim();
        if (!trimmed) {
          showPromptWithStatus();
          return;
        }

        if (!trimmed.startsWith('/') && !isAuthConfigured(session.settings)) {
          console.log('⚠ Debes configurar la autenticación primero con /auth.');
          showPromptWithStatus();
          return;
        }

        const result = await handleUserInputLine(trimmed, {
          session,
          agentLoop,
          ask,
          onAuthUpdated: () => refreshModelsIfNeeded(session),
          onExit: () => {
            rl.close();
            resolve();
          },
        });

        if (trimmed === '/exit') {
          return;
        }

        if (result.handledAsSlash) {
          showPromptWithStatus();
        } else if (result.queuedTask) {
          // Input loop NO espera a que termine el agent loop: permite slash commands en vivo
          void result.queuedTask.then(() => {
            process.stdout.write(os.EOL);
            showPromptWithStatus();
          });
        }
      })();
    });

    rl.on('close', () => resolve());
  });
}

const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('index.js') ||
    process.argv[1].endsWith('index.ts') ||
    process.argv[1].includes('glitch'));

if (isDirectExecution && !process.env['VITEST']) {
  main().catch((err) => {
    console.error('Error fatal:', err);
    process.exit(1);
  });
}
